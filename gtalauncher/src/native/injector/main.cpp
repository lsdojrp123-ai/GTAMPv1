// GTAMP Injector — CreateRemoteThread injector for gtamp_hook.dll.
// FiveM-style: prefers reusing an already-running game, waits for the game
// window (= D3D init done) before touching the process, and every stage is
// reported on stdout so the launcher UI cannot stall silently. The window
// wait is best-effort: if we never match the window (odd title / store
// wrapper), we inject anyway once the timeout passes — a game that survived
// that long is past D3D init. Never kills the game. Exit codes:
//   0 injected | 1 process-timeout | 3 process exited | 4 inject failed
#include <windows.h>
#include <tlhelp32.h>
#include <stdio.h>
#include <string.h>
#include <wchar.h>

static void dbg(const wchar_t* fmt, ...) {
    wchar_t b[1024]; va_list ap; va_start(ap, fmt); _vsnwprintf(b, 1023, fmt, ap); b[1023] = 0; va_end(ap);
    const wchar_t* p = _wgetenv(L"GTAMP_LOG");
    if (!p || !*p) return;
    wchar_t lp[520]; _snwprintf(lp, 519, L"%s", p); lp[519] = 0;
    FILE* f = _wfopen(lp, L"a, ccs=UTF-8");
    if (!f) return;
    SYSTEMTIME st; GetLocalTime(&st);
    fwprintf(f, L"[%02d:%02d:%02d.%03d] %s\n", st.wHour, st.wMinute, st.wSecond, st.wMilliseconds, b);
    fclose(f);
}
static void emitLine(const wchar_t* s) { // stdout must survive even if the pipe is weird: raw WriteFile
    DWORD w = 0; HANDLE h = GetStdHandle(STD_OUTPUT_HANDLE);
    WriteFile(h, s, (DWORD)(wcslen(s) * sizeof(wchar_t)), &w, NULL);
    WriteFile(h, L"\n", 2, &w, NULL);
    FlushFileBuffers(h);
}
static void stage(const wchar_t* fmt, ...) {
    wchar_t b[1024]; va_list ap; va_start(ap, fmt); _vsnwprintf(b, 1023, fmt, ap); b[1023] = 0; va_end(ap);
    emitLine(b); dbg(L"%s", b);
}
static void logErr(const wchar_t* tag) {
    DWORD e = GetLastError(); wchar_t* m = NULL;
    FormatMessageW(FORMAT_MESSAGE_ALLOCATE_BUFFER | FORMAT_MESSAGE_FROM_SYSTEM, NULL, e, 0, (wchar_t*)&m, 0, NULL);
    stage(L"error:%s code=%lu %s", tag, e, m ? m : L"");
    if (m) LocalFree(m);
    if (wcsncmp(tag, L"inject-failed", 13) == 0) ExitProcess(4);
}

static bool argFlag(const wchar_t* name) {
    int argc = 0; wchar_t** argv = CommandLineToArgvW(GetCommandLineW(), &argc);
    bool has = false; for (int i = 1; i < argc; i++) if (!wcscmp(argv[i], name)) has = true;
    LocalFree(argv); return has;
}

static bool isGameExe(const wchar_t* wanted, const wchar_t* got) {
    if (!_wcsicmp(wanted, got)) return true;
    // Either edition counts as "the game" (Legacy GTA5.exe / Enhanced GTA5_Enhanced.exe)
    if (!_wcsicmp(wanted, L"GTA5.exe") && !_wcsicmp(got, L"GTA5_Enhanced.exe")) return true;
    if (!_wcsicmp(wanted, L"GTA5_Enhanced.exe") && !_wcsicmp(got, L"GTA5.exe")) return true;
    return false;
}
static DWORD findPid(const wchar_t* exe) {
    DWORD pid = 0;
    HANDLE s = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
    if (s == INVALID_HANDLE_VALUE) return 0;
    PROCESSENTRY32W e; e.dwSize = sizeof(e);
    if (Process32FirstW(s, &e)) do {
        if (isGameExe(exe, e.szExeFile)) { pid = e.th32ProcessID; break; }
    } while (Process32NextW(s, &e));
    CloseHandle(s);
    return pid;
}
static bool processAlive(DWORD pid) {
    HANDLE h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
    if (!h) return true; // can't query ≠ dead (access denied); assume alive
    DWORD c = 0; BOOL ok = GetExitCodeProcess(h, &c); CloseHandle(h);
    return ok && c == STILL_ACTIVE;
}
struct WinCtx { DWORD pid; HWND hwnd; HWND soft; wchar_t titles[900]; };
static BOOL CALLBACK enumWin(HWND h, LPARAM lp) {
    WinCtx* c = (WinCtx*)lp;
    DWORD p = 0; GetWindowThreadProcessId(h, &p);
    if (p != c->pid) return TRUE;
    wchar_t t[220] = { 0 }; GetWindowTextW(h, t, 219);
    if (wcslen(c->titles) + wcslen(t) + 24 < 899) {
        wchar_t row[260]; _snwprintf(row, 259, L" [vis=%d len=%d]\"%s\"", IsWindowVisible(h) ? 1 : 0, (int)wcslen(t), t);
        wcscat(c->titles, row);
    }
    if (!IsWindowVisible(h)) return TRUE;
    if (GetWindowTextLengthW(h) > 0) { if (!c->hwnd) c->hwnd = h; }
    else if (!c->soft) c->soft = h; // v1.9.6 — fullscreen/untitled windows count too (FiveM gates on nothing)
    return TRUE;
}
static HWND findWindowForPid(DWORD pid, wchar_t* titlesOut = NULL, HWND* softOut = NULL) {
    WinCtx c; c.pid = pid; c.hwnd = NULL; c.soft = NULL; c.titles[0] = 0;
    EnumWindows(enumWin, (LPARAM)&c);
    if (titlesOut) { wcsncpy(titlesOut, c.titles, 899); titlesOut[899] = 0; }
    if (softOut) *softOut = c.soft;
    return c.hwnd;
}

// v2.1.0 — SECOND, independent way to see the game: FIND THE ACTUAL WINDOW. If GTA is on
// the user's screen, its top-level window title is "Grand Theft Auto V" (Legacy) or
// "Grand Theft Auto V Enhanced" — adopt THAT pid even if the process-name scan somehow
// cannot see it (launcher wrapper, renamed exe, store variant). Directly answers the
// report: "it doesn't know that the game is open".
struct AdoptCtx { DWORD pid; wchar_t title[260]; };
static BOOL CALLBACK enumAdopt(HWND h, LPARAM lp) {
    AdoptCtx* c = (AdoptCtx*)lp;
    if (!IsWindowVisible(h)) return TRUE;
    wchar_t t[260] = { 0 }; GetWindowTextW(h, t, 259);
    if (!t[0]) return TRUE;
    wchar_t low[260]; wcscpy(low, t); CharLowerW(low);
    if (wcsstr(low, L"grand theft auto")) { // matches Legacy + Enhanced titles
        DWORD p = 0; GetWindowThreadProcessId(h, &p);
        if (p) { c->pid = p; wcsncpy(c->title, t, 259); c->title[259] = 0; return FALSE; }
    }
    return TRUE;
}
static DWORD findPidByGameWindow(wchar_t* titleOut) {
    AdoptCtx c; c.pid = 0; c.title[0] = 0;
    EnumWindows(enumAdopt, (LPARAM)&c);
    if (titleOut) { wcsncpy(titleOut, c.title, 259); titleOut[259] = 0; }
    return c.pid;
}

// v1.9.9 — can we actually open the process for injection? (elevated game from a
// non-elevated launcher = ACCESS_DENIED; fail fast with a clear error instead of
// burning the whole window wait and dying at CreateRemoteThread minutes later)
static bool canOpenForInject(DWORD pid) {
    HANDLE h = OpenProcess(PROCESS_CREATE_THREAD | PROCESS_QUERY_INFORMATION |
                           PROCESS_VM_OPERATION | PROCESS_VM_WRITE | PROCESS_VM_READ, FALSE, pid);
    if (h) { CloseHandle(h); return true; }
    return GetLastError() != ERROR_ACCESS_DENIED; // transient errors: keep trying
}

static DWORD WINAPI winMainThunk(LPVOID) { return 0; }

int WINAPI wWinMain(HINSTANCE hi, HINSTANCE, wchar_t* cmd, int) {
    wchar_t dll[1024] = { 0 }, process[260] = L"GTA5.exe", adoptedTitle[260] = { 0 };
    DWORD pid = 0, waitMs = 120000, settleMs = 6000, pidTimeoutMs = 0;
    bool waitPid = false, waitWindow = false, alreadyRunning = false, dlloverride = false, adoptedByWindow = false;
    {
        // parse from our own copy of the command line (GUI-subsystem apps get it via GetCommandLineW)
        int argc = 0; wchar_t** argv = CommandLineToArgvW(GetCommandLineW(), &argc);
        for (int i = 1; i < argc; i++) {
            if (!wcscmp(argv[i], L"--dll") && i + 1 < argc) wcsncpy(dll, argv[++i], 1023);
            else if (!wcscmp(argv[i], L"--process") && i + 1 < argc) wcsncpy(process, argv[++i], 259);
            else if (!wcscmp(argv[i], L"--pid") && i + 1 < argc) pid = wcstoul(argv[++i], NULL, 10);
            else if (!wcscmp(argv[i], L"--wait-pid")) waitPid = true;
            else if (!wcscmp(argv[i], L"--wait-window")) waitWindow = true;
            else if (!wcscmp(argv[i], L"--already-running")) alreadyRunning = true;
            else if (!wcscmp(argv[i], L"--settle-ms") && i + 1 < argc) settleMs = wcstoul(argv[++i], NULL, 10);
            else if (!wcscmp(argv[i], L"--timeout") && i + 1 < argc) waitMs = wcstoul(argv[++i], NULL, 10);
            else if (!wcscmp(argv[i], L"--pid-timeout") && i + 1 < argc) pidTimeoutMs = wcstoul(argv[++i], NULL, 10);
            else if (!wcscmp(argv[i], L"--dlloverride")) dlloverride = true;
        }
        LocalFree(argv);
    }
    dbg(L"GTAMP injector 2.1.1 pid=%lu dlloverride=%d waitpid=%d waitwindow=%d alreadyrunning=%d settle=%lums timeout=%lums dll=[%s]",
        pid, dlloverride ? 1 : 0, waitPid ? 1 : 0, waitWindow ? 1 : 0, alreadyRunning ? 1 : 0, settleMs, waitMs, dll);

    // --probe: instant process check, no injection and no --dll required (v1.9.8 native gtaRunning)
    if (argFlag(L"--probe")) {
        DWORD p = pid ? pid : findPid(process);
        if (!p) {
            wchar_t at[260] = { 0 };
            p = findPidByGameWindow(at); // v2.1.0 — see the game by its window, always
            if (p) stage(L"stage:process-adopted-by-window pid=%lu title=\"%s\"", p, at);
        }
        if (p && processAlive(p)) { stage(L"stage:process-found pid=%lu%s", p, canOpenForInject(p) ? L"" : L" elevated=1"); return 0; }
        stage(L"error:process-timeout %s", process);
        return 1;
    }
    if (!dll[0]) { stage(L"error:no-dll"); return 2; }

    // 1) resolve the game process — v1.9.8 uses its own pid timeout so process wait and window wait have separate budgets
    if (!pid) {
        DWORD pidWait = pidTimeoutMs ? pidTimeoutMs : waitMs;
        ULONGLONG deadline = GetTickCount64() + (waitPid ? pidWait : 0);
        int ptick = 0;
        for (;;) {
            pid = findPid(process);
            if (!pid) {
                wchar_t at[260] = { 0 };
                pid = findPidByGameWindow(at); // v2.1.0 — if you can SEE the game, so can we
                if (pid) { adoptedByWindow = true; wcsncpy(adoptedTitle, at, 259); adoptedTitle[259] = 0; }
            }
            if (pid) break;
            if (!waitPid || GetTickCount64() >= deadline) { stage(L"error:process-timeout %s", process); return 1; }
            if ((++ptick % 10) == 0) stage(L"stage:waiting-pid sec=%lu", (DWORD)(ptick / 2));
            Sleep(500);
        }
    }
    stage(L"stage:process-found pid=%lu", pid);
    if (adoptedByWindow) stage(L"stage:process-adopted-by-window pid=%lu title=\"%s\"", pid, adoptedTitle);

    // v1.9.9 — elevation/access pre-check: if we can never open the process for injection
    // (game running as admin, launcher not), say so in seconds, not after the window wait
    if (!alreadyRunning) {
        bool openOk = false;
        for (int t = 0; t < 6 && !openOk; t++) { openOk = canOpenForInject(pid); if (!openOk) Sleep(500); }
        if (!openOk && !canOpenForInject(pid)) { stage(L"error:access-denied pid=%lu", pid); return 5; }
    }

    // 2) window wait (FiveM-parity settled-D3D gate) — skipped for reused instances
    bool windowOk = false;
    if (adoptedByWindow) {
        // v2.1.0 — we FOUND the game through this window; the D3D gate is already satisfied
        stage(L"stage:window-found pid=%lu title=\"%s\"", pid, adoptedTitle);
        windowOk = true;
    } else if (waitWindow && !alreadyRunning) {
        ULONGLONG wstart = GetTickCount64();
        ULONGLONG deadline = wstart + waitMs;
        wchar_t title[260] = { 0 };
        int tick = 0;
        for (;;) {
            if (!processAlive(pid)) { stage(L"error:process-exited pid=%lu", pid); return 3; }
            wchar_t titles[900]; HWND soft = NULL;
            HWND w = findWindowForPid(pid, titles, &soft);
            if (!w && soft && GetTickCount64() - wstart >= 30000) w = soft; // 30s in: an untitled visible window is good enough
            if (w) {
                GetWindowTextW(w, title, 259);
                stage(L"stage:window-found pid=%lu title=\"%s\"", pid, title);
                windowOk = true;
                break;
            }
            if ((++tick % 10) == 0) stage(L"stage:waiting-window sec=%lu", (DWORD)(tick / 2));
            if ((tick % 40) == 0) { // include the raw window titles we can see — catches ENB/UIPI-hidden windows in one screenshot
                wchar_t slim[160]; slim[0] = 0; wcsncat(slim, titles[0] ? titles : L"(none)", 150);
                stage(L"stage:waiting-window-titles pid=%lu%s", pid, slim);
            }
            if (GetTickCount64() >= deadline) {
                dbg(L"window wait timed out — proceeding blind. final candidates:%s", titles[0] ? titles : L"(none)");
                stage(L"stage:window-timeout pid=%lu", pid);
                settleMs = settleMs < 3000 ? 3000 : settleMs; // still give it a beat
                break;
            }
            Sleep(500);
        }
    } else if (waitWindow && alreadyRunning) {
        dbg(L"reused game instance — skipping window wait");
        settleMs = settleMs < 2000 ? 2000 : settleMs;
    }
    if (!processAlive(pid)) { stage(L"error:process-exited pid=%lu", pid); return 3; }

    // 3) settle grace, then inject
    stage(L"stage:settling ms=%lu%s", settleMs, windowOk ? L"" : (alreadyRunning ? L" reused" : L" blind"));
    Sleep(settleMs);
    if (!processAlive(pid)) { stage(L"error:process-exited pid=%lu", pid); return 3; }

    HANDLE h = OpenProcess(PROCESS_CREATE_THREAD | PROCESS_QUERY_INFORMATION | PROCESS_VM_OPERATION | PROCESS_VM_WRITE | PROCESS_VM_READ, FALSE, pid);
    if (!h) { logErr(L"inject-failed OpenProcess"); return 4; }
    SIZE_T sz = (wcslen(dll) + 1) * sizeof(wchar_t);
    LPVOID mem = VirtualAllocEx(h, NULL, sz, MEM_COMMIT | MEM_RESERVE, PAGE_READWRITE);
    if (!mem) { logErr(L"inject-failed VirtualAllocEx"); CloseHandle(h); return 4; }
    if (!WriteProcessMemory(h, mem, dll, sz, NULL)) { logErr(L"inject-failed WriteProcessMemory"); CloseHandle(h); return 4; }
    LPTHREAD_START_ROUTINE load = (LPTHREAD_START_ROUTINE)GetProcAddress(GetModuleHandleW(L"kernel32.dll"), dlloverride ? "LoadLibraryA" : "LoadLibraryW");
    if (!load) { logErr(L"inject-failed LoadLibraryResolve"); CloseHandle(h); return 4; }
    HANDLE t = CreateRemoteThread(h, NULL, 0, load, mem, 0, NULL);
    if (!t) { logErr(L"inject-failed CreateRemoteThread"); CloseHandle(h); return 4; }
    WaitForSingleObject(t, 20000);
    DWORD loadRc = 0; GetExitCodeThread(t, &loadRc);
    CloseHandle(t); VirtualFreeEx(h, mem, 0, MEM_RELEASE); CloseHandle(h);
    stage(L"stage:injected pid=%lu loadRc=%lu", pid, loadRc);
    return 0;
}

// Some mingw toolchains need a console-style entry too — provide both.
int wmain(int argc, wchar_t** argv) {
    (void)argc; (void)argv;
    return wWinMain(GetModuleHandleW(NULL), NULL, GetCommandLineW(), SW_SHOW);
}
