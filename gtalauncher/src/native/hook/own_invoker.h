/* GTAMP own native resolution (v2.2.0) - behavior port of FiveM's rage-scripting-five
 * component (github.com/citizenfx/fivem: code/components/rage-scripting-five/src/scrEngine.cpp,
 * include/scrThread.h and src/TableBuilder.cpp). GTAMP documents this port in
 * gtalauncher/docs/FIVEM-PARITY.md.
 *
 * The game registers every script native in a 256-bucket hash table. On all current builds
 * each entry is XOR-obfuscated with its own address: the next-pointer, the entry count and
 * every stored hash are each folded through the pointer value of where they live. We locate
 * the table with the same code pattern FiveM uses ("76 32 48 8B 53 40", RIP-relative
 * reference at +9), de-obfuscate, resolve our native hashes to handler addresses (trying the
 * per-build re-keyed hashes from native_remap.h when the day-zero hash is absent) and invoke
 * with a call context whose layout matches rage::scrNativeCallContext exactly.
 *
 * Result: GTAMP resolves natives ITSELF, like FiveM. A stale/forked ScriptHookV native
 * database can no longer stop the multiplayer engine with "FATAL: Can't find native".
 * Everything here is defensive: any structural surprise disables this path and the hook
 * falls back to the ScriptHookV exports exactly as v2.1.1 did.
 */
#pragma once
#include <windows.h>
#include <stdint.h>
#include <stdio.h>
#include <stdarg.h>
#include <string.h>
#include "native_remap.h"

namespace own {

// ---------------- log plumbing (wired to hook logf) ----------------
typedef void (*LogFn)(const char*);
static LogFn g_log = 0;
static char  g_logBuf[512];
static void setLogger(LogFn f){ g_log = f; }
static void vlog(const char* fmt, ...){
    if(!g_log) return;
    va_list a; va_start(a,fmt); vsnprintf(g_logBuf,sizeof(g_logBuf),fmt,a); va_end(a);
    g_log(g_logBuf);
}

// ---- rage::scrNativeCallContext layout (FiveM scrThread.h, behavior-ported) ----
// Handlers read args from m_pArgs (8-byte slots), write results to m_pReturn (8-byte
// slots). Vector3 results land as 3 floats, one per slot (stride 8). The vector staging
// space mirrors FiveM so any handler that stages vector-outs writes where we expect.
struct alignas(16) NativeCallContext {
    void*     m_pReturn;       // +0
    uint32_t  m_nArgCount;     // +8
    uint32_t  _p0;             // +12
    void*     m_pArgs;         // +16
    uint32_t  m_nDataCount;    // +24
    uint32_t  _p1;             // +28
    void*     m_outVec[4];     // +32
    float     m_inVec[4][4];   // +64 (16 bytes per staged vector)
    uint8_t   _pad[96];        // +128
};
typedef void (__cdecl *NativeHandler)(NativeCallContext*);

// ---- obfuscated registration entry (FiveM scrEngine.cpp, behavior-ported) ----
#pragma pack(push,1)
struct RegEntry {
    uint64_t  n1;              // +0x00: XOR-folded next-registration pointer
    uint64_t  n2;              // +0x08: rest of the fold key
    NativeHandler handlers[7]; // +0x10: function pointers, plain (readable as-is)
    uint32_t  c1;              // +0x48: XOR-folded entry count (1..7)
    uint32_t  c2;              // +0x4C
    uint32_t  _pad;            // +0x50
    uint64_t  h[14];           // +0x54: seven XOR-folded hash/?? pairs
};
#pragma pack(pop)

// Each fold is: value32_step = (low32(address_of_field) ^ low32(second_key_field)) ^ stored_dword
static RegEntry* nextOf(RegEntry* e){
    uint32_t key = (uint32_t)(uintptr_t)e ^ (uint32_t)e->n2;
    uint32_t lo  = key ^ (uint32_t)e->n1;
    uint32_t hi  = key ^ (uint32_t)(e->n1 >> 32);
    return (RegEntry*)(((uint64_t)hi << 32) | (uint64_t)lo);
}
static uint32_t countOf(RegEntry* e){
    return ((uint32_t)(uintptr_t)&e->c1) ^ e->c1 ^ e->c2;
}
static uint64_t hashOf(RegEntry* e, uint32_t i){
    uintptr_t naddr = (uintptr_t)e + 0x54 + (uintptr_t)i * 16;
    uint32_t key = (uint32_t)naddr ^ *(uint32_t*)(naddr + 8);
    uint32_t lo  = key ^ *(uint32_t*)naddr;
    uint32_t hi  = key ^ *(uint32_t*)(naddr + 4);
    return ((uint64_t)hi << 32) | (uint64_t)lo;
}

// ---------------- memory hygiene (never dereference blindly) ----------------
static bool readable(const void* p, size_t n){
    (void)n;
    MEMORY_BASIC_INFORMATION mbi;
    if(!p || !VirtualQuery(p,&mbi,sizeof(mbi))) return false;
    if(mbi.State != MEM_COMMIT) return false;
    DWORD pr = mbi.Protect & 0xFF;
    return pr==PAGE_READONLY || pr==PAGE_READWRITE || pr==PAGE_WRITECOPY ||
           pr==PAGE_EXECUTE_READ || pr==PAGE_EXECUTE_READWRITE || pr==PAGE_EXECUTE_WRITECOPY;
}
static bool executable(const void* p){
    MEMORY_BASIC_INFORMATION mbi;
    if(!p || !VirtualQuery(p,&mbi,sizeof(mbi))) return false;
    if(mbi.State != MEM_COMMIT) return false;
    DWORD pr = mbi.Protect & 0xFF;
    return pr==PAGE_EXECUTE || pr==PAGE_EXECUTE_READ || pr==PAGE_EXECUTE_READWRITE || pr==PAGE_EXECUTE_WRITECOPY;
}

// ---------------- table location ----------------
static RegEntry** g_table = 0;
static int  g_state = 0;        // 0 = probing, 1 = active, -1 = permanently unavailable
static int  g_attempts = 0;
static int  g_totalNatives = 0;
static uintptr_t g_imgBase = 0; static uint32_t g_imgSize = 0;

// Structural proof that a candidate really is the native registration table:
// 256 buckets, every chain readable, counts in range, thousands of registered natives.
static bool looksValid(RegEntry** tab){
    if(!readable(tab, 256*sizeof(void*))) return false;
    int total = 0;
    for(int b=0;b<256;b++){
        RegEntry* e = tab[b];
        int depth = 0;
        while(e){
            if(!readable(e, sizeof(RegEntry))) return false;
            if(depth >= 64) return false;
            uint32_t n = countOf(e);
            if(n == 0 || n > 7) return false;
            total += (int)n;
            if(total > 20000) return false;
            e = nextOf(e);
            depth++;
        }
    }
    if(total < 1000) return false;  // the game registers ~6000
    g_totalNatives = total;
    return true;
}

// FiveM pattern "76 32 48 8B 53 40": jbe +0x32; mov rdx,[rbx+0x40]
// The RIP-relative table reference sits at match+9 (disp32 there; target = +9 + disp + 4).
static int init(uintptr_t base, uint32_t size){
    if(g_state != 0) return g_state;
    g_attempts++;
    if(!base || size < 0x100000) return 0;
    g_imgBase = base; g_imgSize = size;
    uint8_t* lo = (uint8_t*)base;
    uint8_t* hi = lo + size - 16;
    uint8_t* cand[8]; int ncand = 0;
    for(uint8_t* p = lo; p < hi; p++){
        if(p[0]==0x76 && p[1]==0x32 && p[2]==0x48 && p[3]==0x8B && p[4]==0x53 && p[5]==0x40){
            if(ncand < 8){ cand[ncand++] = p; }
        }
    }
    if(!ncand){ vlog("owninv: registration-table pattern not found yet (attempt %d)", g_attempts); return 0; }
    for(int i=0;i<ncand;i++){
        RegEntry** tab = (RegEntry**)((uintptr_t)cand[i] + 9 + *(int32_t*)(cand[i] + 9) + 4);
        if(looksValid(tab)){
            g_table = tab; g_state = 1;
            vlog("owninv: native table @ %p — %d natives registered. GTAMP resolves natives ITSELF (FiveM behavior).",
                 (void*)tab, g_totalNatives);
            return 1;
        }
    }
    vlog("owninv: %d pattern candidate(s) failed structural checks (attempt %d)", ncand, g_attempts);
    return 0;
}
static void fail(){ if(g_state==0) g_state=-1; }
static int  state(){ return g_state; }
static int  natives(){ return g_totalNatives; }
static bool active(){ return g_state==1; }

// ---------------- resolution (with fast-path cache + per-build rekeys) ----------------
struct CacheEnt { uint64_t hash; NativeHandler fn; };
static CacheEnt g_cache[128];
static int      g_cacheN = 0;
static int      g_resolved = 0, g_missed = 0;

static NativeHandler tableFind(uint64_t hash){
    RegEntry* e = g_table[hash & 0xFF];
    int depth = 0;
    while(e && depth < 64){
        if(!readable(e, sizeof(RegEntry))) return 0;
        uint32_t n = countOf(e);
        if(n > 7) return 0;
        for(uint32_t i=0;i<n;i++)
            if(hashOf(e,i) == hash) return e->handlers[i];
        e = nextOf(e);
        depth++;
    }
    return 0;
}

static NativeHandler resolve(uint64_t hash){
    if(g_state != 1) return 0;
    for(int i=0;i<g_cacheN;i++) if(g_cache[i].hash==hash) return g_cache[i].fn;
    NativeHandler fn = tableFind(hash);
    if(!fn){
        // R* re-keys natives between builds (FiveM TableBuilder.cpp behavior). Try the
        // current keys first: slot 27 (b2944+, all current builds) back to 24 (b2372).
        for(int r=0;r<OWN_REMAP_COUNT && !fn;r++)
            if(g_ownRemap[r].orig == hash)
                for(int k=3;k>=0 && !fn;k--)
                    fn = tableFind(g_ownRemap[r].v[k]);
    }
    if(fn){
        if(!executable((const void*)(uintptr_t)fn)){ vlog("owninv: handler for 0x%016llX rejected (not executable): %p", (unsigned long long)hash, (void*)(uintptr_t)fn); return 0; }
        if(g_cacheN < 128){ g_cache[g_cacheN].hash = hash; g_cache[g_cacheN].fn = fn; g_cacheN++; }
        g_resolved++;
    } else {
        if(g_missed < 16){ vlog("owninv: no handler for native 0x%016llX in this build's table", (unsigned long long)hash); }
        g_missed++;
    }
    return fn;
}
static int resolved(){ return g_resolved; }
static int missed(){ return g_missed; }

// ---------------- invocation (FiveM NativeInvoke behavior) ----------------
static uint64_t* invoke(NativeHandler fn, const uint64_t* args, uint32_t n){
    static __declspec(thread) uint64_t buf[40];
    static __declspec(thread) NativeCallContext ctx;
    memset(buf, 0, sizeof(buf));
    memset(&ctx, 0, sizeof(ctx));
    if(n > 32) n = 32;
    if(n && args) memcpy(buf, args, n*8);
    ctx.m_pReturn   = buf;   // same buffer for args and return — game handles this (FiveM note)
    ctx.m_pArgs     = buf;
    ctx.m_nArgCount = n;
    ctx.m_nDataCount = 0;
    fn(&ctx);
    // rage SetVectorResults (FiveM scrThread.h, behavior-ported): copy staged vectors out,
    // each destination written as 3 floats at 8-byte stride.
    for(uint32_t i=0;i<ctx.m_nDataCount && i<4;i++){
        uint8_t* d = (uint8_t*)ctx.m_outVec[i];
        if(d){ memcpy(d+0, &ctx.m_inVec[i][0], 4); memcpy(d+8, &ctx.m_inVec[i][1], 4); memcpy(d+16, &ctx.m_inVec[i][2], 4); }
    }
    return buf;
}

}; // namespace own
