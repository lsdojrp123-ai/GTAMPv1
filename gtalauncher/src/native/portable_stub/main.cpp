/*
 * GTAMP Portable launcher stub (v2 - reliable)
 *
 * Layout of final GTAMP-Launcher-Portable.exe:
 *   [stub.exe] [app.zip] [8-byte little-endian zip size] [4 bytes "GTAM"]
 *
 * At runtime:
 *   1. Open self, read last 12 bytes
 *   2. Verify "GTAM" magic, read zip size
 *   3. Seek to zipStart = fileSize - 12 - zipSize
 *   4. Extract embedded app.zip into %LOCALAPPDATA%\GTAMP\app using Shell.Application
 *   5. Launch "GTAMP Launcher.exe" from there
 */
#include <windows.h>
#include <shellapi.h>
#include <shlobj.h>
#include <shldisp.h>
#include <shlwapi.h>
#include <stdio.h>
#include <string>
#include <vector>
#include <algorithm>
#pragma comment(lib, "shell32.lib")
#pragma comment(lib, "ole32.lib")
#pragma comment(lib, "uuid.lib")
#pragma comment(lib, "shlwapi.lib")

#define GTAMP_FOOTER_MAGIC 0x4D415447u  // 'GTAM' little-endian

#pragma pack(push, 1)
struct Footer {
    unsigned __int64 zipSize;
    unsigned int     magic;
};
#pragma pack(pop)

static std::wstring GetBaseDir() {
    wchar_t* p = NULL;
    std::wstring r;
    if (SUCCEEDED(SHGetKnownFolderPath(FOLDERID_LocalAppData, 0, NULL, &p))) {
        r = std::wstring(p) + L"\\GTAMP";
        CoTaskMemFree(p);
    } else {
        wchar_t tmp[MAX_PATH];
        GetTempPathW(MAX_PATH, tmp);
        r = std::wstring(tmp) + L"GTAMP";
    }
    return r;
}

// Use Shell.Application to unzip.  srcZip & dstDir must be full paths.
static bool ExtractZip(const wchar_t* srcZip, const wchar_t* dstDir) {
    HRESULT hr = CoInitializeEx(NULL, COINIT_APARTMENTTHREADED | COINIT_DISABLE_OLE1DDE);
    if (FAILED(hr) && hr != RPC_E_CHANGED_MODE) return false;

    IShellDispatch* pShell = NULL;
    Folder* pSrcFolder = NULL;
    Folder* pDstFolder = NULL;
    FolderItems* pItems = NULL;
    bool ok = false;

    // Create destination
    SHCreateDirectoryExW(NULL, dstDir, NULL);

    hr = CoCreateInstance(CLSID_Shell, NULL, CLSCTX_INPROC_SERVER,
                          IID_PPV_ARGS(&pShell));
    if (FAILED(hr) || !pShell) goto done;

    {
        VARIANT vDir; VariantInit(&vDir);
        vDir.vt = VT_BSTR; vDir.bstrVal = SysAllocString(dstDir);
        hr = pShell->NameSpace(vDir, &pDstFolder);
        VariantClear(&vDir);
        if (FAILED(hr) || !pDstFolder) goto done;
    }
    {
        VARIANT vZip; VariantInit(&vZip);
        vZip.vt = VT_BSTR; vZip.bstrVal = SysAllocString(srcZip);
        hr = pShell->NameSpace(vZip, &pSrcFolder);
        VariantClear(&vZip);
        if (FAILED(hr) || !pSrcFolder) goto done;
    }
    hr = pSrcFolder->Items(&pItems);
    if (FAILED(hr) || !pItems) goto done;

    {
        VARIANT vItems; VariantInit(&vItems);
        vItems.vt = VT_DISPATCH; vItems.pdispVal = pItems;
        VARIANT vOpts; VariantInit(&vOpts);
        vOpts.vt = VT_I4;
        // FOF_SILENT | FOF_NOCONFIRMATION | FOF_NOERRORUI | FOF_NO_UI
        vOpts.lVal = 4 | 16 | 1024 | 512;
        // Must be a long variant (CopyHere is fussy)
        pDstFolder->CopyHere(vItems, vOpts);
        VariantClear(&vItems);
        VariantClear(&vOpts);
    }

    // CopyHere is async - wait for file count to match
    // Simple approach: poll until the main exe appears, with timeout
    {
        std::wstring mainExe = std::wstring(dstDir) + L"\\GTAMP Launcher.exe";
        for (int i = 0; i < 120; i++) {
            Sleep(500);
            if (GetFileAttributesW(mainExe.c_str()) != INVALID_FILE_ATTRIBUTES) {
                ok = true;
                break;
            }
        }
    }

done:
    if (pItems) pItems->Release();
    if (pSrcFolder) pSrcFolder->Release();
    if (pDstFolder) pDstFolder->Release();
    if (pShell) pShell->Release();
    CoUninitialize();
    return ok;
}

int wmain() {
    wchar_t exePath[MAX_PATH];
    GetModuleFileNameW(NULL, exePath, MAX_PATH);

    HANDLE hFile = CreateFileW(exePath, GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                               NULL, OPEN_EXISTING, 0, NULL);
    if (hFile == INVALID_HANDLE_VALUE) {
        MessageBoxW(NULL, L"Cannot open launcher EXE (read error).", L"GTAMP", MB_ICONERROR);
        return 1;
    }

    LARGE_INTEGER liSize;
    if (!GetFileSizeEx(hFile, &liSize)) {
        CloseHandle(hFile);
        MessageBoxW(NULL, L"Cannot determine EXE size.", L"GTAMP", MB_ICONERROR);
        return 1;
    }
    unsigned __int64 fileSize = (unsigned __int64)liSize.QuadPart;

    // Need at least a tiny stub + 1 byte zip + footer
    if (fileSize < (1024 * 100) + sizeof(Footer)) {
        CloseHandle(hFile);
        MessageBoxW(NULL, L"EXE appears too small - corrupted?", L"GTAMP", MB_ICONERROR);
        return 1;
    }

    // Read footer (last sizeof(Footer) bytes)
    Footer footer = {0, 0};
    LARGE_INTEGER liFoot;
    liFoot.QuadPart = (LONGLONG)fileSize - (LONGLONG)sizeof(Footer);
    if (SetFilePointerEx(hFile, liFoot, NULL, FILE_BEGIN) == 0) {
        CloseHandle(hFile);
        MessageBoxW(NULL, L"Cannot read EXE footer.", L"GTAMP", MB_ICONERROR);
        return 1;
    }
    DWORD read = 0;
    ReadFile(hFile, &footer, sizeof(footer), &read, NULL);
    CloseHandle(hFile);

    if (footer.magic != GTAMP_FOOTER_MAGIC || footer.zipSize == 0 ||
        footer.zipSize > fileSize - sizeof(Footer) - 1024) {
        MessageBoxW(NULL, L"Appendix missing or corrupt. Download a fresh copy.", L"GTAMP", MB_ICONERROR);
        return 1;
    }

    unsigned __int64 zipStart = fileSize - sizeof(Footer) - footer.zipSize;

    std::wstring base = GetBaseDir();
    std::wstring appDir = base + L"\\app";
    std::wstring mainExe = appDir + L"\\GTAMP Launcher.exe";
    std::wstring stampFile = appDir + L"\\.installed";
    std::wstring tmpZip = base + L"\\update.zip";

    // Check if already installed
    if (GetFileAttributesW(mainExe.c_str()) == INVALID_FILE_ATTRIBUTES) {
        CreateDirectoryW(base.c_str(), NULL);
        CreateDirectoryW(appDir.c_str(), NULL);

        // Extract the appended ZIP to a temp file
        HANDLE hIn = CreateFileW(exePath, GENERIC_READ, FILE_SHARE_READ, NULL,
                                 OPEN_EXISTING, 0, NULL);
        HANDLE hOut = CreateFileW(tmpZip.c_str(), GENERIC_WRITE, 0, NULL,
                                  CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL | FILE_FLAG_SEQUENTIAL_SCAN, NULL);
        if (hIn == INVALID_HANDLE_VALUE || hOut == INVALID_HANDLE_VALUE) {
            if (hIn != INVALID_HANDLE_VALUE) CloseHandle(hIn);
            if (hOut != INVALID_HANDLE_VALUE) CloseHandle(hOut);
            MessageBoxW(NULL, L"Cannot write temp file. Run from a writable location.", L"GTAMP", MB_ICONERROR);
            return 1;
        }

        LARGE_INTEGER liStart; liStart.QuadPart = (LONGLONG)zipStart;
        SetFilePointerEx(hIn, liStart, NULL, FILE_BEGIN);

        unsigned __int64 remaining = footer.zipSize;
        std::vector<BYTE> buf(1 << 20); // 1 MB buffer
        while (remaining > 0) {
            DWORD chunk = (DWORD)std::min((unsigned __int64)buf.size(), remaining);
            DWORD got = 0;
            if (!ReadFile(hIn, buf.data(), chunk, &got, NULL) || got == 0) break;
            DWORD wrote = 0;
            WriteFile(hOut, buf.data(), got, &wrote, NULL);
            remaining -= got;
        }
        CloseHandle(hOut);
        CloseHandle(hIn);

        // Extract using Shell.Application
        bool extracted = ExtractZip(tmpZip.c_str(), appDir.c_str());
        DeleteFileW(tmpZip.c_str());

        if (!extracted) {
            // Fallback: try PowerShell if Shell.Application failed (rare)
            wchar_t cmd[4096];
            _snwprintf(cmd, 4096,
                L"powershell -NoProfile -NonInteractive -WindowStyle Hidden -Command \""
                L"$ErrorActionPreference='Stop';"
                L"Expand-Archive -Path '%ls' -DestinationPath '%ls' -Force\"",
                tmpZip.c_str(), appDir.c_str());
            STARTUPINFOW si = {sizeof(si)};
            PROCESS_INFORMATION pi = {0};
            si.dwFlags = STARTF_USESHOWWINDOW; si.wShowWindow = SW_HIDE;
            if (CreateProcessW(NULL, cmd, NULL, NULL, FALSE, CREATE_NO_WINDOW, NULL, NULL, &si, &pi)) {
                WaitForSingleObject(pi.hProcess, 60000);
                CloseHandle(pi.hThread); CloseHandle(pi.hProcess);
                DeleteFileW(tmpZip.c_str());
            }
        }

        // Write stamp
        HANDLE hS = CreateFileW(stampFile.c_str(), GENERIC_WRITE, 0, NULL,
                                CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, NULL);
        if (hS != INVALID_HANDLE_VALUE) CloseHandle(hS);
    }

    if (GetFileAttributesW(mainExe.c_str()) == INVALID_FILE_ATTRIBUTES) {
        MessageBoxW(NULL,
            L"GTAMP Launcher could not be extracted.\n\n"
            L"Try:\n"
            L"  1. Running as Administrator (right-click -> Run as admin)\n"
            L"  2. Moving the EXE out of Downloads/protected folders\n"
            L"  3. Using Windows 10 or later with PowerShell enabled",
            L"GTAMP", MB_ICONERROR);
        return 1;
    }

    // Launch the real launcher
    ShellExecuteW(NULL, L"open", mainExe.c_str(), NULL, appDir.c_str(), SW_SHOWNORMAL);
    return 0;
}
