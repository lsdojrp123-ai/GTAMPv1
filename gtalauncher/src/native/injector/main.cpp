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

static DWORD WINAPI winMainThunk(LPVOID) { return 0; }

int WINAPI wWinMain(HINSTANCE hi, HINSTANCE, wchar_t* cmd, int) {
    wchar_t dll[1024] = { 0 }, process[260] = L"GTA5.exe";
    DWORD pid = 0, waitMs = 120000, settleMs = 6000, pidTimeoutMs = 0;
    bool waitPid = false, waitWindow = false, alreadyRunning = false, dlloverride = false;
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
    dbg(L"GTAMP injector 1.9.8 pid=%lu dlloverride=%d waitpid=%d waitwindow=%d alreadyrunning=%d settle=%lums timeout=%lums dll=[%s]",
        pid, dlloverride ? 1 : 0, waitPid ? 1 : 0, waitWindow ? 1 : 0, alreadyRunning ? 1 : 0, settleMs, waitMs, dll);

    // --probe: instant process check, no injection and no --dll required (v1.9.8 native gtaRunning)
    if (argFlag(L"--probe")) {
        DWORD p = pid ? pid : findPid(process);
        if (p && processAlive(p)) { stage(L"stage:process-found pid=%lu", p); return 0; }
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
            if (pid) break;
            if (!waitPid || GetTickCount64() >= deadline) { stage(L"error:process-timeout %s", process); return 1; }
            if ((++ptick % 20) == 0) dbg(L"still waiting for process %s …", process);
            Sleep(500);
        }
    }
    stage(L"stage:process-found pid=%lu", pid);

    // 2) window wait (FiveM-parity settled-D3D gate) — skipped for reused instances
    bool windowOk = false;
    if (waitWindow && !alreadyRunning) {
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
            if ((++tick % 20) == 0) dbg(L"waiting for window of pid=%lu … candidates:%s", pid, titles[0] ? titles : L"(none)");
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
