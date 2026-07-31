// Minimal MinHook-style x86-64 inline trampoline hook (single-header, no license issues).
// Enough to detour 1-2 functions (Present/ResizeBuffers). Based on public-domain concepts.
#pragma once
#include <windows.h>
#include <cstdint>
#include <cstring>

namespace mh {
    struct Hook {
        void* target;
        void* detour;
        void* original;
        uint8_t stub[32];
        uint8_t origBytes[14];
        bool installed;
    };

    static uint8_t* allocateNearStub(void* target) {
        uint8_t* p = (uint8_t*)target;
        SYSTEM_INFO si; GetSystemInfo(&si);
        for (int64_t off = -0x7FFFF000; off <= 0x7FFFF000; off += si.dwAllocationGranularity) {
            uint8_t* at = p + off;
            MEMORY_BASIC_INFORMATION mbi;
            if (VirtualQuery(at,&mbi,sizeof(mbi)) &&
                mbi.State == MEM_FREE &&
                VirtualAlloc(at, 64, MEM_COMMIT|MEM_RESERVE, PAGE_EXECUTE_READWRITE))
                return at;
        }
        return nullptr;
    }

    static bool createHook(Hook& h, void* target, void* detour) {
        h.target = target; h.detour = detour; h.installed = false;
        DWORD old;
        uint8_t* p = (uint8_t*)target;
        // Must be writable
        VirtualProtect(p, 14, PAGE_EXECUTE_READWRITE, &old);
        memcpy(h.origBytes, p, 14);
        // Build trampoline: mov rax, detour; jmp rax (12 bytes), placed near target
        h.stub[0] = 0x48; h.stub[1] = 0xB8; // mov rax, imm64
        memcpy(h.stub+2, &detour, 8);
        h.stub[10] = 0xFF; h.stub[11] = 0xE0; // jmp rax
        // For trampoline (original function path) we copy overwritten bytes + jmp back after hook
        uint8_t* tramp = allocateNearStub(target);
        if (!tramp) { VirtualProtect(p,14,old,&old); return false; }
        memcpy(tramp, h.origBytes, 14);
        tramp[14] = 0x48; tramp[15] = 0xB8;
        void* cont = (uint8_t*)target + 14;
        memcpy(tramp+16, &cont, 8);
        tramp[24] = 0xFF; tramp[25] = 0xE0;
        h.original = tramp;
        // Write JMP at target -> detour (14 bytes)
        p[0] = 0x48; p[1] = 0xB8;
        memcpy(p+2, &detour, 8);
        p[10] = 0xFF; p[11] = 0xE0;
        p[12] = 0x90; p[13] = 0x90;
        VirtualProtect(p,14,old,&old);
        FlushInstructionCache(GetCurrentProcess(), target, 14);
        h.installed = true;
        return true;
    }
}
