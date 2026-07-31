/*
 * GTAMP DLL Injector
 * Waits for a target process (default: GTA5.exe), then injects gtamp_hook.dll
 * using the classic VirtualAllocEx + WriteProcessMemory + CreateRemoteThread + LoadLibraryW.
 *
 * Usage: gtamp_injector.exe --process GTA5.exe --dll C:\path\to\gtamp_hook.dll [--timeout 60000]
 */
#include <windows.h>
#include <tlhelp32.h>
#include <psapi.h>
#include <stdio.h>
#include <string>
#include <vector>

// Provide a WinMain that forwards to wmain so we can build with -mwindows
// (no popup console) while keeping a standard wmain(argc, argv) entry.
extern "C" int __cdecl wmain(int, wchar_t**);
int WINAPI WinMain(HINSTANCE, HINSTANCE, LPSTR, int) {
    int argc;
    wchar_t** argv = CommandLineToArgvW(GetCommandLineW(), &argc);
    int r = wmain(argc, argv);
    LocalFree(argv);
    return r;
}

static void print(const wchar_t* msg) {
    // Write to a log file alongside the exe for debugging
    wchar_t path[MAX_PATH];
    GetModuleFileNameW(NULL, path, MAX_PATH);
    wchar_t* slash = wcsrchr(path, L'\\');
    if (slash) { wcscpy(slash + 1, L"gtamp_injector.log"); }
    FILE* f = _wfopen(path, L"a");
    if (f) { fputws(msg, f); fputwc(L'\n', f); fclose(f); }
    OutputDebugStringW(msg);
}

static DWORD findProcess(const wchar_t* name) {
    HANDLE snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
    if (snap == INVALID_HANDLE_VALUE) return 0;
    PROCESSENTRY32W pe = {sizeof(pe)};
    DWORD pid = 0;
    if (Process32FirstW(snap, &pe)) {
        do {
            if (_wcsicmp(pe.szExeFile, name) == 0) {
                pid = pe.th32ProcessID;
                break;
            }
        } while (Process32NextW(snap, &pe));
    }
    CloseHandle(snap);
    return pid;
}

static bool inject(DWORD pid, const wchar_t* dllPath) {
    HANDLE hProc = OpenProcess(PROCESS_CREATE_THREAD | PROCESS_VM_OPERATION |
                              PROCESS_VM_WRITE | PROCESS_VM_READ | PROCESS_QUERY_INFORMATION,
                              FALSE, pid);
    if (!hProc) {
        wchar_t buf[512];
        swprintf(buf, 512, L"OpenProcess failed: %u", GetLastError());
        print(buf);
        return false;
    }

    size_t sz = (wcslen(dllPath) + 1) * sizeof(wchar_t);
    LPVOID mem = VirtualAllocEx(hProc, NULL, sz, MEM_COMMIT | MEM_RESERVE, PAGE_READWRITE);
    if (!mem) { print(L"VirtualAllocEx failed"); CloseHandle(hProc); return false; }

    if (!WriteProcessMemory(hProc, mem, dllPath, sz, NULL)) {
        print(L"WriteProcessMemory failed");
        VirtualFreeEx(hProc, mem, 0, MEM_RELEASE);
        CloseHandle(hProc);
        return false;
    }

    LPTHREAD_START_ROUTINE loadLib = (LPTHREAD_START_ROUTINE)
        GetProcAddress(GetModuleHandleW(L"kernel32.dll"), "LoadLibraryW");
    if (!loadLib) { print(L"GetProcAddress(LoadLibraryW) failed"); return false; }

    HANDLE hThread = CreateRemoteThread(hProc, NULL, 0, loadLib, mem, 0, NULL);
    if (!hThread) {
        wchar_t buf[512];
        swprintf(buf, 512, L"CreateRemoteThread failed: %u", GetLastError());
        print(buf);
        VirtualFreeEx(hProc, mem, 0, MEM_RELEASE);
        CloseHandle(hProc);
        return false;
    }

    // Wait up to 10s for the LoadLibrary call
    WaitForSingleObject(hThread, 10000);

    DWORD rcode = 0;
    GetExitCodeThread(hThread, &rcode);

    CloseHandle(hThread);
    VirtualFreeEx(hProc, mem, 0, MEM_RELEASE);
    CloseHandle(hProc);

    if (rcode == 0) {
        print(L"LoadLibraryW returned NULL - DLL may have failed to load");
        return false;
    }

    print(L"DLL injected successfully");
    return true;
}

int wmain(int argc, wchar_t** argv) {
    const wchar_t* procName = L"GTA5.exe";
    const wchar_t* dllPath = NULL;
    int timeoutMs = 60000;

    for (int i = 1; i < argc; i++) {
        if (wcscmp(argv[i], L"--process") == 0 && i+1 < argc) procName = argv[++i];
        else if (wcscmp(argv[i], L"--dll") == 0 && i+1 < argc) dllPath = argv[++i];
        else if (wcscmp(argv[i], L"--timeout") == 0 && i+1 < argc) timeoutMs = _wtoi(argv[++i]);
    }

    if (!dllPath) {
        print(L"Usage: gtamp_injector.exe --process GTA5.exe --dll <path> [--timeout ms]");
        return 1;
    }

    // Resolve dll path to absolute
    wchar_t absDll[MAX_PATH];
    if (!GetFullPathNameW(dllPath, MAX_PATH, absDll, NULL)) {
        print(L"GetFullPathNameW failed");
        return 1;
    }

    if (GetFileAttributesW(absDll) == INVALID_FILE_ATTRIBUTES) {
        wchar_t buf[512];
        swprintf(buf, 512, L"DLL not found: %s", absDll);
        print(buf);
        return 1;
    }

    {
        wchar_t buf[1024];
        swprintf(buf, 1024, L"Waiting for %s (timeout %dms), dll=%s", procName, timeoutMs, absDll);
        print(buf);
    }

    int waited = 0;
    DWORD pid = 0;
    while (waited < timeoutMs) {
        pid = findProcess(procName);
        if (pid) break;
        Sleep(500);
        waited += 500;
    }

    if (!pid) {
        print(L"Timed out waiting for target process");
        return 1;
    }

    {
        wchar_t buf[256];
        swprintf(buf, 256, L"Found %s PID %u, injecting...", procName, pid);
        print(buf);
    }

    // Give GTA a few seconds to initialize (avoid early injection crashing)
    Sleep(5000);

    bool ok = inject(pid, absDll);
    return ok ? 0 : 1;
}
