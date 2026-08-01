/* Minimal ScriptHookV runtime bindings - load SHV.dll at runtime, call natives via exports.
 * Yielding: uses scriptWait EXPORT (g_CurrentScript->Wait) like every working SHV script.
 */
#pragma once
#include <windows.h>
#include <stdint.h>
#include <stdio.h>
#include <stdarg.h>
#include <math.h>
#include <string.h>
#include <ctype.h>
#include "../hook/own_invoker.h"

namespace shv {
    typedef void      (*NativeInit_t)(uint64_t hash);
    typedef void      (*NativePush64_t)(uint64_t value);
    typedef uint64_t* (*NativeCall_t)();
    typedef void      (*ScriptMain_t)();
    typedef void      (*ScriptRegister_t)(HINSTANCE mod, ScriptMain_t fn);
    typedef void      (*ScriptUnregister_t)(ScriptMain_t fn);
    typedef void      (*ScriptWait_t)(DWORD ms);

    static HMODULE               g_dll = nullptr;
    static NativeInit_t          g_init = nullptr;
    static NativePush64_t        g_push = nullptr;
    static NativeCall_t          g_call = nullptr;
    static ScriptRegister_t      g_register = nullptr;
    static ScriptUnregister_t    g_unregister = nullptr;
    static ScriptWait_t          g_wait = nullptr;
    static HINSTANCE             g_selfHinst = nullptr;

    typedef void (*LogFn)(const char* line);
    static LogFn g_log = nullptr;
    static char  g_logBuf[2048];
    static void setLogger(LogFn f){g_log=f;}
    static void setSelfHinst(HINSTANCE h){g_selfHinst=h;}
    static void vlog(const char* fmt,...){
        if(!g_log) return;
        va_list a; va_start(a,fmt); vsnprintf(g_logBuf,sizeof(g_logBuf),fmt,a); va_end(a);
        g_log(g_logBuf);
    }

    static bool loaded(){return g_dll && g_init && g_push && g_call && g_register && g_unregister && g_wait;}

    static FARPROC getProcByName(HMODULE m, const char* name){
        FARPROC p=GetProcAddress(m,name);
        if(p) return p;
        uint8_t* base=(uint8_t*)m;
        IMAGE_DOS_HEADER* dos=(IMAGE_DOS_HEADER*)base;
        if(!dos||dos->e_magic!=IMAGE_DOS_SIGNATURE) return nullptr;
        IMAGE_NT_HEADERS* nt=(IMAGE_NT_HEADERS*)(base+dos->e_lfanew);
        auto dir=nt->OptionalHeader.DataDirectory[IMAGE_DIRECTORY_ENTRY_EXPORT];
        if(!dir.VirtualAddress||!dir.Size) return nullptr;
        IMAGE_EXPORT_DIRECTORY* exp=(IMAGE_EXPORT_DIRECTORY*)(base+dir.VirtualAddress);
        DWORD* names=(DWORD*)(base+exp->AddressOfNames);
        WORD*  ords =(WORD*) (base+exp->AddressOfNameOrdinals);
        DWORD* addrs=(DWORD*)(base+exp->AddressOfFunctions);
        for(DWORD i=0;i<exp->NumberOfNames;i++){
            const char* n=(const char*)(base+names[i]);
            if(strstr(n,name)){
                if(g_log){char b[256];snprintf(b,sizeof(b),"SHV export fuzzy match '%s' -> '%s'",name,n);vlog(b);}
                return (FARPROC)(base+addrs[ords[i]]);
            }
        }
        return nullptr;
    }

    static bool load(){
        if(loaded()) return true;
        g_dll = GetModuleHandleA("ScriptHookV.dll");
        if(!g_dll) g_dll = GetModuleHandleA("ScriptHookV");
        if(!g_dll){
            char gtaDir[MAX_PATH]={0};
            HMODULE hm=GetModuleHandleA("GTA5.exe");
            if(hm && GetModuleFileNameA(hm,gtaDir,MAX_PATH)){
                char* sl=strrchr(gtaDir,'\\'); if(sl)*sl=0;
                SetDllDirectoryA(gtaDir);
            }
            g_dll = LoadLibraryA("ScriptHookV.dll");
        }
        if(!g_dll){vlog("SHV load failed (err=%u)",(unsigned)GetLastError());return false;}
        g_init     = (NativeInit_t)       getProcByName(g_dll,"nativeInit");
        g_push     = (NativePush64_t)     getProcByName(g_dll,"nativePush64");
        g_call     = (NativeCall_t)       getProcByName(g_dll,"nativeCall");
        g_register = (ScriptRegister_t)   getProcByName(g_dll,"scriptRegister");
        g_unregister=(ScriptUnregister_t) getProcByName(g_dll,"scriptUnregister");
        g_wait     = (ScriptWait_t)       getProcByName(g_dll,"scriptWait");
        if(!g_init || !g_push || !g_call || !g_register || !g_unregister || !g_wait){
            vlog("SHV exports missing: init=%p push=%p call=%p reg=%p unreg=%p wait=%p",
                (void*)g_init,(void*)g_push,(void*)g_call,(void*)g_register,(void*)g_unregister,(void*)g_wait);
            g_dll=nullptr; return false;
        }
        vlog("SHV exports resolved OK (init=%p push=%p call=%p reg=%p unreg=%p wait=%p)",
            (void*)g_init,(void*)g_push,(void*)g_call,(void*)g_register,(void*)g_unregister,(void*)g_wait);
        return true;
    }

    static void registerScript(ScriptMain_t fn){
        if(!g_register) return;
        HINSTANCE hi = g_selfHinst ? g_selfHinst : (HINSTANCE)GetModuleHandleA(NULL);
        vlog("scriptRegister(hinst=%p, fn=%p)",(void*)hi,(void*)fn);
        g_register(hi, fn);
    }
    static void unregisterScript(ScriptMain_t fn){
        if(g_unregister && fn) g_unregister(fn);
    }

    // Yield via scriptWait export — the correct way per SHV SDK.
    static void wait(DWORD ms){
        if(g_wait) g_wait(ms);
    }

    // v2.2.0 — GTAMP resolves natives itself first (FiveM behavior; own_invoker.h).
    // ScriptHookV stays as the fiber scheduler and as the native fallback path.
    struct Invoker {
        uint64_t hash;
        own::NativeHandler ownFn;
        uint64_t ownArgs[32];
        uint32_t ownN;
        Invoker(uint64_t h):hash(h),ownFn(own::resolve(h)),ownN(0){ if(!ownFn && g_init) g_init(hash); }
        Invoker& arg(uint64_t v){ if(ownFn){ if(ownN<32) ownArgs[ownN++]=v; } else if(g_push) g_push(v); return *this; }
        Invoker& argf(float f){ uint64_t v=0; memcpy(&v,&f,4); return arg(v); }
        Invoker& argi(int v){ return arg((uint64_t)(int64_t)v); }
        Invoker& argu(uint32_t v){ return arg((uint64_t)v); }
        Invoker& argh(uint32_t h){ return argu(h); }
        Invoker& argb(bool v){ return arg(v?1ULL:0ULL); }
        Invoker& argp(void* p){ return arg((uintptr_t)p); }
        uint64_t* call(){ if(ownFn) return own::invoke(ownFn,ownArgs,ownN); return g_call ? g_call() : nullptr; }
        int     reti(){ uint64_t* r=call(); return r?(int)(int64_t)*r:0; }
        float   retf(){ uint64_t* r=call(); if(!r)return 0.f; float f; memcpy(&f,r,4); return f; }
        void*   retp(){ uint64_t* r=call(); return r?(void*)(uintptr_t)*r:nullptr; }
        bool    retb(){ uint64_t* r=call(); return r && (*r & 0xFF) != 0; }
        void    ret3f(float& x,float& y,float& z){
            uint64_t* r=call();
            if(!r){x=y=z=0.f;return;}
            memcpy(&x,(uint8_t*)r+0,4);
            memcpy(&y,(uint8_t*)r+8,4);
            memcpy(&z,(uint8_t*)r+16,4);
        }
        void    retv(){ call(); }
    };

    static uint32_t joaat(const char* key){
        uint32_t h=0; const unsigned char* k=(const unsigned char*)key;
        while(*k){h+=(uint8_t)tolower(*k++);h+=(h<<10);h^=(h>>6);}
        h+=(h<<3);h^=(h>>11);h+=(h<<15);return h;
    }
};
