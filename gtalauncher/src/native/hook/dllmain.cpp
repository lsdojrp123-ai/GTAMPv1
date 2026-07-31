/* GTAMP Hook v1.5.2 - Phase 5: remote player position sync (cross-thread native-call fix). */
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <winsock2.h>
#include <ws2tcpip.h>
#include <psapi.h>
#include <mmsystem.h>
#include <stdio.h>
#include <stdarg.h>
#include <stdint.h>
#include <math.h>
#include <string.h>
#include <ctype.h>
#include "../shv/shv_invoker.h"
#pragma comment(lib,"ws2_32.lib")
#pragma comment(lib,"psapi.lib")
#pragma comment(lib,"version.lib")
#pragma comment(lib,"winmm.lib")

#define HOOK_VER "1.5.2"
#define OVERLAY_KEY RGB(255,0,255)
#define OV_CLASS "GTAMP_OV152"
static volatile bool g_running=true;
static HANDLE g_ovT=NULL, g_netT=NULL;
static HWND g_ov=NULL, g_gta=NULL;
static DWORD g_pid=0;
static SOCKET g_sock=INVALID_SOCKET;
static bool g_vis=true;
static char g_ver[64]={0};
struct Vec3{float x,y,z;};
static uintptr_t g_base=0; static uint32_t g_size=0;
struct Found{bool found;uintptr_t ped;Vec3 pos;float heading;int hp;uintptr_t world;char why[128];char err[256];uint32_t tries;uint32_t cands;} g_f={0};
static bool g_shvReady=false;
static char g_shvMsg[256]={0};
static int g_shvSpawnCount=0;
static int g_netPedCount=0;
static Vec3 g_shvLastPedCoords={0,0,0};
static float g_shvLastHeading=0.f;
static int g_localPed=0;
struct SpawnReq{char src[8];char model[64];float x,y,z,h;bool useOffset;int pedType;};
// Remote players (server-broadcast). NetPlayerId -> ped handle + state.
#define NET_PED_MAX 32
struct NetPed{int used;char id[32];char name[32];char model[64];int ped;Vec3 pos;float h;DWORD lastUpdate;};
static NetPed g_netPeds[NET_PED_MAX];
// Ring-buffer queue so spawns that arrive before SHV ready are NOT dropped.
#define SPAWN_Q_SIZE 16
#define NQ_SPAWN 1
#define NQ_DEL   2
#define NQ_CLEAR 3
struct NpCmd{int op;char id[32];char name[32];char model[64];float x,y,z,h;};
#define NP_Q_SIZE 64
static void logf(const char* fmt,...); // forward decl
static SpawnReq g_spawnQ[SPAWN_Q_SIZE];
static NpCmd g_npQ[NP_Q_SIZE];
static volatile LONG g_qHead=0,g_qTail=0;
static volatile LONG g_npHead=0,g_npTail=0;
static CRITICAL_SECTION g_qCs;
static CRITICAL_SECTION g_npCs;
static inline void spawnQ_strcpy(char*dst,const char*src,size_t sz){
    if(!dst||!sz)return; if(!src)src="";
    size_t i=0;for(;i+1<sz&&src[i];i++)dst[i]=src[i];
    dst[i]=0;
}
static void queueSpawn(const SpawnReq*r){
    EnterCriticalSection(&g_qCs);
    LONG t=g_qTail;
    int idx=((int)t)&(SPAWN_Q_SIZE-1);
    SpawnReq*slot=&g_spawnQ[idx];
    memset(slot,0,sizeof(*slot));
    const char*srcStr=(r->src[0])?r->src:"NET";
    const char*mdlStr=(r->model[0])?r->model:"s_m_y_cop_01";
    spawnQ_strcpy(slot->src,srcStr,sizeof(slot->src));
    spawnQ_strcpy(slot->model,mdlStr,sizeof(slot->model));
    slot->x=r->x;slot->y=r->y;slot->z=r->z;slot->h=r->h;
    slot->useOffset=r->useOffset;slot->pedType=r->pedType?r->pedType:6;
    g_qTail=t+1;
    // If queue overflowed, advance head to drop oldest
    if(g_qTail-g_qHead>SPAWN_Q_SIZE){g_qHead=g_qTail-SPAWN_Q_SIZE;logf("spawnQ: overflow, dropped oldest");}
    LeaveCriticalSection(&g_qCs);
}

static void logf(const char* fmt,...){
    char b[2048];va_list a;va_start(a,fmt);vsnprintf(b,sizeof(b),fmt,a);va_end(a);
    OutputDebugStringA("[GTAMP] ");OutputDebugStringA(b);OutputDebugStringA("\n");
    char tmp[MAX_PATH];GetTempPathA(MAX_PATH,tmp);strcat_s(tmp,MAX_PATH,"gtamp_hook.log");
    FILE*f=fopen(tmp,"a");if(f){SYSTEMTIME s;GetLocalTime(&s);fprintf(f,"[%02u:%02u:%02u.%03u] %s\n",s.wHour,s.wMinute,s.wSecond,s.wMilliseconds,b);fclose(f);}
}
static CRITICAL_SECTION g_sendCs;
static void sl(const char*s){if(!s||g_sock==INVALID_SOCKET)return;EnterCriticalSection(&g_sendCs);send(g_sock,s,(int)strlen(s),0);LeaveCriticalSection(&g_sendCs);}
static void sendJson(const char*fmt,...){char b[1024];va_list a;va_start(a,fmt);vsnprintf(b,sizeof(b),fmt,a);va_end(a);size_t n=strlen(b);if(n<sizeof(b)-2){b[n]='\n';b[n+1]=0;}sl(b);}

static bool isBad(uintptr_t a,size_t n){return !a||IsBadReadPtr((void*)a,n)!=0;}
static uintptr_t readPtr(uintptr_t a){if(isBad(a,8))return 0;uintptr_t v;memcpy(&v,(void*)a,8);return v;}
static bool readBuf(uintptr_t a,void*o,size_t n){if(isBad(a,n))return false;memcpy(o,(void*)a,n);return true;}
static bool isHeap(uintptr_t p){
    if(!p||p<0x10000||p>0x7FFFFFFFFFFF)return false;if(p>=g_base&&p<g_base+g_size)return false;
    MEMORY_BASIC_INFORMATION m;if(VirtualQuery((void*)p,&m,sizeof(m))==0)return false;
    if(m.State!=MEM_COMMIT)return false;DWORD rw=PAGE_READWRITE|PAGE_EXECUTE_READWRITE|PAGE_WRITECOPY;return(m.Protect&rw)!=0;
}
static bool hasVtableInModule(uintptr_t obj){uintptr_t vt=readPtr(obj);return vt&&vt>=g_base&&vt<g_base+g_size;}
static uint8_t* findSigInSec(const char*sec,const uint8_t*sig,const char*msk,int*pm){
    uint8_t*b=(uint8_t*)g_base;IMAGE_DOS_HEADER*dos=(IMAGE_DOS_HEADER*)b;IMAGE_NT_HEADERS*nt=(IMAGE_NT_HEADERS*)(b+dos->e_lfanew);
    IMAGE_SECTION_HEADER*sh=IMAGE_FIRST_SECTION(nt);uintptr_t st=0;uint32_t sz=0;
    for(WORD i=0;i<nt->FileHeader.NumberOfSections;i++){char n[9]={0};memcpy(n,sh[i].Name,8);if(!_stricmp(n,sec)){sz=sh[i].Misc.VirtualSize;st=g_base+sh[i].VirtualAddress;break;}}
    if(!st)return NULL;int L=(int)strlen(msk);uint8_t*first=NULL;int matches=0;
    for(uint8_t*p=(uint8_t*)st,*e=p+sz-L;p<e;p++){bool ok=true;for(int i=0;i<L;i++)if(msk[i]=='x'&&p[i]!=sig[i]){ok=false;break;}if(ok){if(!first)first=p;matches++;}}
    if(pm)*pm=matches;return matches>=1?first:NULL;
}
static uintptr_t rel32(uint8_t*at,int off){int32_t d;memcpy(&d,at+off,4);return(uintptr_t)(at+off+4)+(intptr_t)d;}
static void detectBuild(HMODULE hm){
    char p[MAX_PATH];GetModuleFileNameA(hm,p,MAX_PATH);DWORD sz=GetFileVersionInfoSizeA(p,NULL);
    if(sz){void*b=malloc(sz);if(b&&GetFileVersionInfoA(p,0,sz,b)){VS_FIXEDFILEINFO*fi=NULL;UINT n;if(VerQueryValueA(b,"\\",(LPVOID*)&fi,&n)&&fi)snprintf(g_ver,sizeof(g_ver),"%u.%u.%u.%u",HIWORD(fi->dwFileVersionMS),LOWORD(fi->dwFileVersionMS),HIWORD(fi->dwFileVersionLS),LOWORD(fi->dwFileVersionLS));}free(b);}
    IMAGE_DOS_HEADER*d=(IMAGE_DOS_HEADER*)hm;IMAGE_NT_HEADERS*n=(IMAGE_NT_HEADERS*)((uint8_t*)hm+d->e_lfanew);g_base=(uintptr_t)hm;g_size=n->OptionalHeader.SizeOfImage;logf("GTA v%s base=%p size=0x%X",g_ver[0]?g_ver:"?",(void*)g_base,g_size);
}
static bool validCoord(Vec3 v,int hp){if(isnan(v.x)||isnan(v.y)||isnan(v.z)||!isfinite(v.x)||!isfinite(v.y)||!isfinite(v.z))return false;if(v.x==0.f&&v.z==0.f)return false;if(v.z<2.f)return false;if(v.x<-4500||v.x>4500||v.y<-5000||v.y>10000||v.z>1500)return false;if(fabsf(v.x)<10.f&&fabsf(v.y)<10.f&&fabsf(v.z)<10.f)return false;if(hp<100||hp>328)return false;return true;}
static bool tryCandidate(uintptr_t ped,uintptr_t off,const char*why){
    if(!isHeap(ped))return false;g_f.tries++;if(!hasVtableInModule(ped))return false;Vec3 v;
    if(!readBuf(ped+0x90,&v,sizeof(v)))return false;float fh=0;int hp=0;if(!readBuf(ped+0x280,&fh,4)||fh<100.f||fh>328.f)return false;hp=(int)fh;if(!validCoord(v,hp))return false;Sleep(40);Vec3 v2;float fh2=0;int hp2=0;if(!readBuf(ped+0x90,&v2,sizeof(v2)))return false;if(!readBuf(ped+0x280,&fh2,4)||fh2<100.f||fh2>328.f)return false;hp2=(int)fh2;if(!validCoord(v2,hp2))return false;g_f.found=true;g_f.ped=ped;g_f.pos=v2;g_f.hp=hp2;g_f.heading=0.f;snprintf(g_f.why,sizeof(g_f.why),"%s slot+0x%X vtab+0x%X",why,(unsigned)off,(unsigned)(readPtr(ped)-g_base));return true;
}
static uintptr_t findWorld(){static const uint8_t sw[]={0x48,0x8B,0x05,0,0,0,0,0x45,0,0,0,0,0x48,0x8B,0x48,0x08,0x48,0x85,0xC9,0x74,0x07};static const char mw[]="xxx????x????xxxxxxxxx";int m=0;uint8_t*h=findSigInSec(".text",sw,mw,&m);if(!h)return 0;return readPtr(rel32(h,3));}
static void doScan(){g_f.found=false;g_f.tries=0;g_f.cands=0;strcpy_s(g_f.err,"Scanning...");uintptr_t w=findWorld();g_f.world=w;if(!w){strcpy_s(g_f.err,"world ptr 0 (loading)");return;}if(!isHeap(w)){strcpy_s(g_f.err,"world not heap yet");return;}uintptr_t k=readPtr(w+0x8);g_f.cands++;if(tryCandidate(k,0x8,"world+0x8"))return;for(uintptr_t o=0x10;o<0x800;o+=8){uintptr_t c=readPtr(w+o);if(!c)continue;g_f.cands++;if(tryCandidate(c,o,"world"))return;}strcpy_s(g_f.err,"No ped found. Retrying...");}
static void sstrcpy(char*dst,const char*src,size_t sz){if(!dst||!sz)return;if(!src){dst[0]=0;return;}size_t i=0;for(;i+1<sz&&src[i];i++)dst[i]=src[i];dst[i]=0;}
static const char* jss(const char*js,const char*k,int*oL){char nd[64];snprintf(nd,sizeof(nd),"\"%s\"",k);const char*p=strstr(js,nd);if(!p)return NULL;p+=strlen(nd);while(*p&&(*p==' '||*p==':'))p++;if(*p!='"')return NULL;p++;const char*e=p;while(*e&&*e!='"')e++;if(oL)*oL=(int)(e-p);return p;}
static bool jsf(const char*js,const char*k,float*o){char nd[64];snprintf(nd,sizeof(nd),"\"%s\"",k);const char*p=strstr(js,nd);if(!p)return false;p+=strlen(nd);while(*p&&(*p==' '||*p==':'))p++;if(!*p)return false;char*e;double d=strtod(p,&e);if(e==p)return false;*o=(float)d;return true;}
static bool jsd(const char*js,const char*k,int*o){char nd[64];snprintf(nd,sizeof(nd),"\"%s\"",k);const char*p=strstr(js,nd);if(!p)return false;p+=strlen(nd);while(*p&&(*p==' '||*p==':'))p++;if(!*p)return false;char*e;long d=strtol(p,&e,10);if(e==p)return false;*o=(int)d;return true;}
static bool jsb(const char*js,const char*k,bool d){char nd[64];snprintf(nd,sizeof(nd),"\"%s\"",k);const char*p=strstr(js,nd);if(!p)return d;p+=strlen(nd);while(*p&&(*p==' '||*p==':'))p++;if(!strncmp(p,"true",4))return true;if(!strncmp(p,"false",5))return false;return d;}
static NetPed* findNetPed(const char*id){for(int i=0;i<NET_PED_MAX;i++){if(g_netPeds[i].used&&!strcmp(g_netPeds[i].id,id))return&g_netPeds[i];}return NULL;}
// NetPed state helpers — safe to call from any thread for lookup/allocation;
// the ped handle MUST NOT be touched (no Invoker/DELETE_ENTITY) from non-SHV threads.
static NetPed* allocNetPed(){for(int i=0;i<NET_PED_MAX;i++){if(!g_netPeds[i].used){memset(&g_netPeds[i],0,sizeof(NetPed));g_netPeds[i].used=1;g_netPedCount++;return&g_netPeds[i];}}return NULL;}
// Queue a net-ped command for the SHV fiber to execute.
static void queueNpCmd(const NpCmd*c){
    EnterCriticalSection(&g_npCs);
    LONG t=g_npTail;
    int idx=((int)t)&(NP_Q_SIZE-1);
    g_npQ[idx]=*c;
    g_npTail=t+1;
    if(g_npTail-g_npHead>NP_Q_SIZE){g_npHead=g_npTail-NP_Q_SIZE;logf("npQ: overflow, dropped oldest");}
    LeaveCriticalSection(&g_npCs);
}
// SHV-fiber-only: actually delete a netPed's entity and free slot.
static void deleteNetPed_SHV(NetPed*np){
    using namespace shv;
    if(!np)return;
    const uint64_t H_DELETE_ENTITY=0xAE3CBE5BF394C9C9ULL;
    if(np->ped){Invoker(H_DELETE_ENTITY).argi(np->ped).argb(false).retv();wait(0);logf("netPed: deleted ped %d id=%s",np->ped,np->id);}
    int idx=(int)(np-g_netPeds);if(idx>=0&&idx<NET_PED_MAX){memset(&g_netPeds[idx],0,sizeof(NetPed));g_netPedCount--;}
}
static int doSpawnPed(const char*modelName,float x,float y,float z,float h,int pedType,bool freeze=false,const char*tag=NULL){
    using namespace shv;
    const uint64_t H_REQUEST_MODEL=0x963D27A58DF860ACULL,
                   H_HAS_MODEL_LOADED=0x98A4EB5D89A0C952ULL,
                   H_CREATE_PED=0xD49F9B0955C367DEULL,
                   H_SET_MODEL_NO=0xE532F5D78798DAABULL,
                   H_SET_PED_DEFAULT_COMP=0x45EEE61580806D63ULL,
                   H_FREEZE=0x428CA6DBD1094446ULL,
                   H_SET_MISSION=0xAD738C3085FE7E11ULL,
                   H_SET_COORDS=0x239A3351AC1DA385ULL,
                   H_SET_HEADING=0x8E2530AA8ADA980EULL,
                   H_SET_INVINCIBLE=0x3882114BDE571AD4ULL;
    uint32_t m=shv::joaat(modelName?modelName:"s_m_y_cop_01");logf("spawn%s: model=%s hash=0x%08X type=%d at %.1f,%.1f,%.1f h=%.1f freeze=%d",tag?tag:"",modelName?modelName:"(null)",m,pedType,x,y,z,h,(int)freeze);
    Invoker(H_REQUEST_MODEL).argh(m).retv();bool loaded=false;DWORD t0=timeGetTime();
    while(timeGetTime()-t0<10000&&g_running){wait(50);int r=Invoker(H_HAS_MODEL_LOADED).argh(m).reti();DWORD el=timeGetTime()-t0;if(el<500||!(el%2000))logf("spawn: HAS_MODEL_LOADED t=%lums -> %d",(long unsigned)el,r);if(r){loaded=true;break;}}
    logf("spawn: model loaded=%d elapsed=%lums",(int)loaded,(long unsigned)(timeGetTime()-t0));int np=0;
    if(loaded){wait(200);np=Invoker(H_CREATE_PED).argi(pedType).argh(m).argf(x).argf(y).argf(z).argf(h).argb(false).argb(true).reti();wait(100);
        if(np){
            Invoker(H_SET_PED_DEFAULT_COMP).argi(np).retv();
            wait(50);
            logf("spawn: default component variation applied to ped %d",np);
            // Extra configuration ONLY for remote (frozen) net peds.
            // Local spawns (F11, /spawncop, SRV welcome, etc.) keep behavior identical to v1.4.8.
            if(freeze){
                wait(50);
                Invoker(H_SET_MISSION).argi(np).argb(true).argb(true).retv();
                wait(30);
                Invoker(H_FREEZE).argi(np).argb(true).retv();
                wait(0);
                Invoker(H_SET_INVINCIBLE).argi(np).argb(true).retv();
                wait(0);
                Invoker(H_SET_COORDS).argi(np).argf(x).argf(y).argf(z).argb(false).argb(false).argb(true).retv();
                wait(0);
                Invoker(H_SET_HEADING).argi(np).argf(h).retv();
                wait(50);
                logf("spawn: ped %d configured as remote (frozen, warped to %.1f,%.1f,%.1f h=%.1f)",np,x,y,z,h);
            }
        }
        Invoker(H_SET_MODEL_NO).argh(m).retv();
    }
    return np;
}
static void processNetPeds(DWORD now){
    using namespace shv;
    const uint64_t H_SET_COORDS=0x239A3351AC1DA385ULL,H_SET_HEADING=0x8E2530AA8ADA980EULL,H_DOES_ENTITY_EXIST=0x7239B21A38F536BAULL;
    for(int i=0;i<NET_PED_MAX;i++){
        NetPed*np=&g_netPeds[i];
        if(!np->used)continue;
        // Expire if no update in 6s
        if(np->lastUpdate!=0 && now-np->lastUpdate>6000){logf("netPed: id=%s timed out (%.1fs), removing",np->id,(now-np->lastUpdate)/1000.0);deleteNetPed_SHV(np);i--;continue;}
        if(!np->ped)continue;
        int exists=Invoker(H_DOES_ENTITY_EXIST).argi(np->ped).reti();
        if(!exists){logf("netPed: id=%s ped=%d no longer exists, clearing handle (will respawn)",np->id,np->ped);np->ped=0;continue;}
        Invoker(H_SET_COORDS).argi(np->ped).argf(np->pos.x).argf(np->pos.y).argf(np->pos.z).argb(false).argb(false).argb(false).retv();
        Invoker(H_SET_HEADING).argi(np->ped).argf(np->h).retv();
    }
}
static void __cdecl shvScriptMain(){
    logf("SHV scriptMain: entered (v" HOOK_VER ")");using namespace shv;
    const uint64_t H_PLAYER_ID=0x4F8644AF03D0E0D6ULL,H_PPID=0xD80958FC74E988A6ULL,H_GEC=0x3FEF770D40960D5AULL,H_GEH=0xE83D4F9BA2A38914ULL;
    wait(5000);logf("SHV: initial 5s wait done.");int pidx=0;DWORD lastTick=0,lastPosSend=0,lastNetTick=0;DWORD t0=timeGetTime();
    while(g_running){wait(0);DWORD now=timeGetTime();
        if(!g_localPed){static DWORD lt=0;if(now-lt>500){lt=now;pidx=Invoker(H_PLAYER_ID).reti();int p=Invoker(H_PPID).reti();if(p&&timeGetTime()-t0>8000){g_localPed=p;g_shvReady=true;logf("SHV READY: playerIdx=%d ped=0x%X (uptime=%ums) netPeds=%d",pidx,p,(unsigned)(timeGetTime()-t0),g_netPedCount);strcpy_s(g_f.err,"Scanning mem for ped...");sendJson("{\"t\":\"ready\",\"ped\":%d,\"uptime\":%lu}",p,(unsigned long)(timeGetTime()-t0));}else{static DWORD ll=0;if(now-ll>3000){ll=now;logf("SHV: waiting for ped... t=%ums p=%d",(unsigned)(timeGetTime()-t0),p);}}}continue;}
        // Apply remote-ped movement every tick (smooth)
        if(now-lastNetTick>16){lastNetTick=now;processNetPeds(now);}
        // Drain net-ped command queue (spawn/del/clear) — SHV fiber ONLY, one cmd per tick.
        EnterCriticalSection(&g_npCs);
        bool hasNp=(g_npTail!=g_npHead);
        NpCmd nc={0};
        if(hasNp){LONG h=g_npHead;int idx=((int)h)&(NP_Q_SIZE-1);nc=g_npQ[idx];g_npHead=h+1;}
        LeaveCriticalSection(&g_npCs);
        if(hasNp){
            if(nc.op==NQ_SPAWN){
                NetPed*np=findNetPed(nc.id);
                if(np&&!np->ped){
                    char tag[64];snprintf(tag,sizeof(tag),"[remote %s]",nc.id);
                    int ped=doSpawnPed(nc.model[0]?nc.model:"s_m_y_cop_01",nc.x,nc.y,nc.z,nc.h,6,true,tag);
                    if(ped){np->ped=ped;g_shvSpawnCount++;logf("net: spawned remote ped id=%s -> ped=%d",nc.id,ped);sendJson("{\"t\":\"netPedSpawned\",\"id\":\"%s\",\"ped\":%d}",nc.id,ped);}
                    else logf("net: FAILED to spawn remote ped id=%s",nc.id);
                }
            }else if(nc.op==NQ_DEL){
                NetPed*np=findNetPed(nc.id);
                if(np)deleteNetPed_SHV(np);
            }else if(nc.op==NQ_CLEAR){
                logf("net: clearing all remote peds (%d)",g_netPedCount);
                for(int i=0;i<NET_PED_MAX;i++){if(g_netPeds[i].used){NetPed*np=&g_netPeds[i];if(np->ped)deleteNetPed_SHV(np);else{memset(np,0,sizeof(NetPed));g_netPedCount--;}i--;}}
            }
            wait(0);
        }
        // Read local pos @ ~20Hz, send to bridge @ ~10Hz
        if(now-lastTick>50){lastTick=now;float x=0,y=0,z=0,h=0;Invoker(H_GEC).argi(g_localPed).argb(true).ret3f(x,y,z);h=Invoker(H_GEH).argi(g_localPed).retf();if(x||y||z){g_shvLastPedCoords.x=x;g_shvLastPedCoords.y=y;g_shvLastPedCoords.z=z;g_shvLastHeading=h;}static DWORD ll=0;if(now-ll>5000){ll=now;logf("SHV tick: pos=%.1f,%.1f,%.1f h=%.1f netPeds=%d",x,y,z,h,g_netPedCount);}if(now-lastPosSend>100){lastPosSend=now;sendJson("{\"t\":\"pos\",\"x\":%.3f,\"y\":%.3f,\"z\":%.3f,\"h\":%.2f,\"ped\":%d}",x,y,z,h,g_localPed);}}
        // Drain one spawn from queue per tick (process oldest pending).
        EnterCriticalSection(&g_qCs);
        bool hasQ=(g_qTail!=g_qHead);
        SpawnReq r={0};
        if(hasQ){
            LONG h=g_qHead;
            int idx=((int)h)&(SPAWN_Q_SIZE-1);
            r=g_spawnQ[idx];
            g_qHead=h+1;
        }
        LeaveCriticalSection(&g_qCs);
        while(hasQ){
            float tx=r.x,ty=r.y,tz=r.z,th=r.h;
            if(r.useOffset){Vec3 me=g_shvLastPedCoords;if((me.x==0.f&&me.y==0.f)&&g_f.found){me.x=g_f.pos.x;me.y=g_f.pos.y;me.z=g_f.pos.z;}float hd=g_shvLastHeading;float rad=hd*0.0174533f;tx=me.x+sinf(rad)*3.f;ty=me.y+cosf(rad)*3.f;tz=me.z;th=hd;}
            const char*src=r.src[0]?r.src:"net";
            logf("spawn: begin src=%s model=%s",src,r.model);
            int np=doSpawnPed(r.model[0]?r.model:"s_m_y_cop_01",tx,ty,tz,th,r.pedType?r.pedType:6);
            if(np){g_shvSpawnCount++;snprintf(g_shvMsg,sizeof(g_shvMsg),"ped=%d (%s) at %.0f,%.0f,%.0f (n=%d)",np,r.model,tx,ty,tz,g_shvSpawnCount);logf("spawn: OK %s",g_shvMsg);}else{snprintf(g_shvMsg,sizeof(g_shvMsg),"spawn FAILED for %s",r.model);logf("spawn: FAIL %s",g_shvMsg);}
            sendJson("{\"t\":\"spawn\",\"ped\":%d,\"model\":\"%s\",\"x\":%.2f,\"y\":%.2f,\"z\":%.2f,\"h\":%.2f,\"ok\":%s,\"n\":%d,\"src\":\"%s\",\"m\":\"%s\"}",np,r.model,tx,ty,tz,th,np?"true":"false",g_shvSpawnCount,src,g_shvMsg);
            wait(50); // tiny spacing between spawns so GTA can settle
            // Grab next queued spawn (if any) under the lock
            EnterCriticalSection(&g_qCs);
            hasQ=(g_qTail!=g_qHead);
            if(hasQ){
                LONG h=g_qHead;
                int idx=((int)h)&(SPAWN_Q_SIZE-1);
                r=g_spawnQ[idx];
                g_qHead=h+1;
            }
            LeaveCriticalSection(&g_qCs);
        }
    }logf("SHV scriptMain: exiting");unregisterScript(shvScriptMain);
}
struct EnumData{DWORD pid;HWND wnd;};
static BOOL CALLBACK enumCb(HWND w,LPARAM lp){EnumData*d=(EnumData*)lp;DWORD pid;GetWindowThreadProcessId(w,&pid);if(pid==d->pid&&IsWindowVisible(w)&&!GetParent(w)){RECT r;GetWindowRect(w,&r);int a=(r.right-r.left)*(r.bottom-r.top);RECT rr;if(!d->wnd||(GetWindowRect(d->wnd,&rr)&&a>(rr.right-rr.left)*(rr.bottom-rr.top)))d->wnd=w;}return TRUE;}
static HWND findGtaWnd(){EnumData d={g_pid,NULL};EnumWindows(enumCb,(LPARAM)&d);return d.wnd;}
static LRESULT CALLBACK wndProc(HWND w,UINT m,WPARAM a,LPARAM b){
    if(m==WM_PAINT){PAINTSTRUCT ps;HDC dc=BeginPaint(w,&ps);HBRUSH kb=CreateSolidBrush(OVERLAY_KEY);RECT rc;GetClientRect(w,&rc);FillRect(dc,&rc,kb);DeleteObject(kb);RECT br={8,8,700,240};HBRUSH b2=CreateSolidBrush(RGB(18,10,2));FillRect(dc,&br,b2);DeleteObject(b2);HPEN pn=CreatePen(PS_SOLID,1,RGB(240,120,40));HGDIOBJ po=SelectObject(dc,pn);MoveToEx(dc,br.left,br.top,NULL);LineTo(dc,br.right,br.top);LineTo(dc,br.right,br.bottom);LineTo(dc,br.left,br.bottom);LineTo(dc,br.left,br.top);SelectObject(dc,po);DeleteObject(pn);SetBkMode(dc,TRANSPARENT);
    HFONT f1=CreateFontA(22,0,0,0,FW_BOLD,0,0,0,DEFAULT_CHARSET,0,0,CLEARTYPE_QUALITY,0,"Segoe UI");HFONT f2=CreateFontA(13,0,0,0,FW_NORMAL,0,0,0,DEFAULT_CHARSET,0,0,CLEARTYPE_QUALITY,0,"Segoe UI");HFONT of=(HFONT)SelectObject(dc,f1);SetTextColor(dc,RGB(240,120,40));char hdr[80];snprintf(hdr,sizeof(hdr),"GTAMP v%s  -  PHASE 5 REMOTE PLAYER SYNC (SHV fiber fix)",HOOK_VER);TextOutA(dc,20,16,hdr,(int)strlen(hdr));SelectObject(dc,f2);char ln[320];SetTextColor(dc,RGB(220,224,232));snprintf(ln,sizeof(ln),"Build: %s   F9=toggle F10=rescan F11=spawn cop",g_ver[0]?g_ver:"?");TextOutA(dc,20,46,ln,(int)strlen(ln));
    if(shv::loaded()){COLORREF c=g_shvReady?RGB(120,220,120):RGB(255,200,80);SetTextColor(dc,c);snprintf(ln,sizeof(ln),"ScriptHookV: OK  script=%s  spawns=%d  remotePeds=%d",g_shvReady?"ready":"starting up",g_shvSpawnCount,g_netPedCount);}else{SetTextColor(dc,RGB(255,160,80));snprintf(ln,sizeof(ln),"ScriptHookV.dll NOT FOUND");}TextOutA(dc,20,64,ln,(int)strlen(ln));
    if(g_shvReady&&g_f.found){SetTextColor(dc,RGB(180,220,255));snprintf(ln,sizeof(ln),"PED @ %p  (+0x90)  mem: %.1f,%.1f,%.1f",(void*)g_f.ped,g_f.pos.x,g_f.pos.y,g_f.pos.z);TextOutA(dc,20,88,ln,(int)strlen(ln));SetTextColor(dc,RGB(180,255,180));snprintf(ln,sizeof(ln),"SHV pos: %.1f,%.1f,%.1f  h=%.1f deg  hp=%d",g_shvLastPedCoords.x,g_shvLastPedCoords.y,g_shvLastPedCoords.z,g_shvLastHeading,g_f.hp);TextOutA(dc,20,108,ln,(int)strlen(ln));SetTextColor(dc,RGB(180,180,180));TextOutA(dc,20,128,g_f.why,(int)strlen(g_f.why));if(g_shvMsg[0]){SetTextColor(dc,RGB(255,220,120));TextOutA(dc,20,148,g_shvMsg,(int)strlen(g_shvMsg));}SetTextColor(dc,RGB(140,200,255));snprintf(ln,sizeof(ln),"Bridge: %s   Remote players online: %d",g_sock!=INVALID_SOCKET?"connected":"waiting",g_netPedCount);TextOutA(dc,20,180,ln,(int)strlen(ln));}else{SetTextColor(dc,RGB(255,200,120));TextOutA(dc,20,88,g_shvReady?"Local ped: scanning memory...":"Waiting for GTA to load...",g_shvReady?33:29);SetTextColor(dc,RGB(180,180,180));TextOutA(dc,20,108,g_f.err,(int)strlen(g_f.err));}
    SetTextColor(dc,RGB(220,180,90));TextOutA(dc,20,200,"F11 or Spawn Cop button = cop 3m in front",42);SelectObject(dc,of);DeleteObject(f1);DeleteObject(f2);EndPaint(w,&ps);return 0;}if(m==WM_DESTROY){g_ov=NULL;return 0;}return DefWindowProcA(w,m,a,b);
}
static DWORD WINAPI overlayThread(LPVOID){logf("overlay start");HINSTANCE hi=(HINSTANCE)GetModuleHandleA(NULL);WNDCLASSEXA wc={0};wc.cbSize=sizeof(wc);wc.lpfnWndProc=wndProc;wc.hInstance=hi;wc.hbrBackground=CreateSolidBrush(OVERLAY_KEY);wc.lpszClassName=OV_CLASS;RegisterClassExA(&wc);for(int i=0;i<200&&g_running;i++){g_gta=findGtaWnd();if(g_gta)break;Sleep(100);}if(g_gta){char t[96]={0};GetWindowTextA(g_gta,t,96);logf("GTA hwnd=%p '%s'",(void*)g_gta,t);}g_ov=CreateWindowExA(WS_EX_TOPMOST|WS_EX_LAYERED|WS_EX_TRANSPARENT|WS_EX_TOOLWINDOW|WS_EX_NOACTIVATE,OV_CLASS,"GTAMP",WS_POPUP|WS_VISIBLE,0,0,720,240,NULL,NULL,hi,NULL);if(g_ov){SetLayeredWindowAttributes(g_ov,OVERLAY_KEY,255,LWA_COLORKEY|LWA_ALPHA);logf("overlay %p",(void*)g_ov);}strcpy_s(g_f.err,"Waiting for SHV ready...");MSG m;DWORD la=timeGetTime();
    while(g_running){while(PeekMessageA(&m,NULL,0,0,PM_REMOVE)){TranslateMessage(&m);DispatchMessageA(&m);}if(!g_gta||!IsWindow(g_gta))g_gta=findGtaWnd();if(g_gta&&IsWindow(g_gta)&&g_ov){RECT g;if(IsWindowVisible(g_gta)&&GetWindowRect(g_gta,&g)){SetWindowPos(g_ov,HWND_TOPMOST,g.left+16,g.top+16,720,240,SWP_NOACTIVATE|SWP_SHOWWINDOW|SWP_NOOWNERZORDER);ShowWindow(g_ov,g_vis?SW_SHOWNOACTIVATE:SW_HIDE);InvalidateRect(g_ov,NULL,FALSE);}}if(GetAsyncKeyState(VK_F9)&1){g_vis=!g_vis;logf("overlay %s",g_vis?"on":"off");Sleep(250);}if(GetAsyncKeyState(VK_F10)&1){if(g_shvReady){logf("rescan (F10)");g_f.found=false;la=timeGetTime()-2000;doScan();}Sleep(250);}if(GetAsyncKeyState(VK_F11)&1){if(shv::loaded()){logf("F11 pressed - queuing local cop spawn (shvReady=%d)",(int)g_shvReady);SpawnReq r={0};strcpy_s(r.src,"F11");strcpy_s(r.model,"s_m_y_cop_01");r.useOffset=true;r.pedType=6;queueSpawn(&r);if(!g_shvReady)snprintf(g_shvMsg,sizeof(g_shvMsg),"F11 queued - will spawn once loaded");}else{logf("F11 pressed but SHV not loaded");snprintf(g_shvMsg,sizeof(g_shvMsg),"Waiting for ScriptHookV...");}Sleep(500);}DWORD now=timeGetTime();if(g_shvReady&&!g_f.found&&now-la>1500){la=now;doScan();}Sleep(25);}if(g_ov)DestroyWindow(g_ov);UnregisterClassA(OV_CLASS,hi);return 0;
}
static void connectBridge(){g_sock=socket(AF_INET,SOCK_STREAM,IPPROTO_TCP);sockaddr_in a={0};a.sin_family=AF_INET;a.sin_port=htons(22100);inet_pton(AF_INET,"127.0.0.1",&a.sin_addr);if(connect(g_sock,(sockaddr*)&a,sizeof(a))==0){char h[256];snprintf(h,sizeof(h),"{\"t\":\"hookHello\",\"v\":\"" HOOK_VER "\",\"gta\":\"%s\"}\n",g_ver);sl(h);logf("bridge connected");}else{closesocket(g_sock);g_sock=INVALID_SOCKET;}}
// Net-thread: parse packet and update NetPed bookkeeping ONLY.
// Any native call (spawn/delete/move) is queued for the SHV fiber.
static void handleNetLine(const char*l){int ln=(int)strlen(l);if(ln<5)return;
    // netPedDel
    if(strstr(l,"\"netPedDel\"")){int il=0;const char*iv=jss(l,"id",&il);if(iv&&il>0){char id[32]={0};memcpy(id,iv,il<31?il:31);NpCmd c={0};c.op=NQ_DEL;sstrcpy(c.id,id,sizeof(c.id));queueNpCmd(&c);logf("net: queued del remote ped id=%s",id);}return;}
    // netPedClear
    if(strstr(l,"\"netPedClear\"")){NpCmd c={0};c.op=NQ_CLEAR;queueNpCmd(&c);logf("net: queued clear all remote peds");return;}
    // netPed / netPedPos
    if(strstr(l,"\"netPedPos\"")||strstr(l,"\"netPed\"")){
        int il=0;const char*iv=jss(l,"id",&il);char id[32]={0};if(iv&&il>0)memcpy(id,iv,il<31?il:31);if(!id[0])return;
        int nl=0;const char*nv=jss(l,"name",&nl);char name[32]="Player";if(nv&&nl>0){memcpy(name,nv,nl<31?nl:31);name[nl<31?nl:31]=0;}
        int ml=0;const char*mv=jss(l,"model",&ml);char model[64]="s_m_y_cop_01";if(mv&&ml>0&&ml<63){memcpy(model,mv,ml);model[ml]=0;}
        float x=0,y=0,z=0,h=0;jsf(l,"x",&x);jsf(l,"y",&y);jsf(l,"z",&z);jsf(l,"h",&h);
        bool isSpawn=!!strstr(l,"\"netPed\"")&&!strstr(l,"\"netPedPos\"");
        EnterCriticalSection(&g_npCs);
        NetPed*np=findNetPed(id);
        bool newly=false;
        if(!np){np=allocNetPed();if(!np){LeaveCriticalSection(&g_npCs);logf("net: netPed table full, dropping id=%s",id);return;}sstrcpy(np->id,id,sizeof(np->id));np->ped=0;newly=true;logf("net: new remote ped id=%s name='%s' model=%s at %.1f,%.1f,%.1f",id,name,model,x,y,z);}
        sstrcpy(np->name,name,sizeof(np->name));
        sstrcpy(np->model,model,sizeof(np->model));
        np->pos.x=x;np->pos.y=y;np->pos.z=z;np->h=h;np->lastUpdate=timeGetTime();
        bool needSpawn=(newly||!np->ped)&&g_shvReady;
        LeaveCriticalSection(&g_npCs);
        if(needSpawn){
            NpCmd c={0};c.op=NQ_SPAWN;sstrcpy(c.id,id,sizeof(c.id));sstrcpy(c.name,name,sizeof(c.name));sstrcpy(c.model,model,sizeof(c.model));
            c.x=x;c.y=y;c.z=z;c.h=h;
            queueNpCmd(&c);
            logf("net: queued spawn remote ped id=%s",id);
        }
        return;
    }
    if(strstr(l,"\"spawnPed\"")||(strstr(l,"\"t\":\"spawn\"")&&!strstr(l,"\"spawned\""))){int ml=0;const char*mv=jss(l,"model",&ml);SpawnReq r={0};strcpy_s(r.src,"NET");int sl=0;const char*sv=jss(l,"src",&sl);if(sv&&sl>0&&sl<(int)sizeof(r.src)-1){memcpy(r.src,sv,sl);r.src[sl]=0;}if(mv&&ml>0&&ml<(int)sizeof(r.model)-1){memcpy(r.model,mv,ml);r.model[ml]=0;}else strcpy_s(r.model,"s_m_y_cop_01");bool off=jsb(l,"offset",false);if(strstr(l,"\"t\":\"spawn\"")&&!strstr(l,"spawnPed"))off=true;if(off){r.useOffset=true;}else{float x,y,z,h;if(!jsf(l,"x",&x)||!jsf(l,"y",&y)||!jsf(l,"z",&z)){logf("net: spawnPed missing coords, using offset");r.useOffset=true;}else{r.useOffset=false;r.x=x;r.y=y;r.z=z;r.h=jsf(l,"h",&h)?h:0.f;}}float ptf=0;r.pedType=jsf(l,"pedType",&ptf)?(int)ptf:6;queueSpawn(&r);if(!g_shvReady)logf("net: queued spawnPed src=%s model=%s (SHV not ready - queued)",r.src,r.model);else logf("net: queued spawnPed src=%s model=%s offset=%d",r.src,r.model,r.useOffset);}
}
static DWORD WINAPI netThread(LPVOID){logf("net start");WSADATA w;WSAStartup(MAKEWORD(2,2),&w);for(int i=0;i<60&&g_running;i++){connectBridge();if(g_sock!=INVALID_SOCKET)break;Sleep(500);}char rb[4096];int rbLen=0;while(g_running){if(g_sock!=INVALID_SOCKET){fd_set r;timeval tv={0,150000};FD_ZERO(&r);FD_SET(g_sock,&r);if(select(0,&r,NULL,NULL,&tv)>0){int n=recv(g_sock,rb+rbLen,(int)sizeof(rb)-1-rbLen,0);if(n<=0){logf("bridge closed");closesocket(g_sock);g_sock=INVALID_SOCKET;rbLen=0;}else{rbLen+=n;rb[rbLen]=0;char*st=rb;for(char*p=rb;p<rb+rbLen;p++){if(*p=='\n'){*p=0;char*line=st;while(*line=='\r'||*line==' ')line++;if(*line){logf("<- %s",line);handleNetLine(line);}st=p+1;}}if(st>rb){int rem=(int)(rb+rbLen-st);memmove(rb,st,rem);rbLen=rem;}else if(rbLen>=(int)sizeof(rb)-1){logf("net: line too long");rbLen=0;}}}}else{Sleep(500);connectBridge();}}if(g_sock!=INVALID_SOCKET){closesocket(g_sock);g_sock=INVALID_SOCKET;}WSACleanup();return 0;}
static VOID WINAPI delayedShvLoad(PVOID){
    {HMODULE pe[2048];DWORD need=0;if(EnumProcessModules(GetCurrentProcess(),(HMODULE*)pe,sizeof(pe),&need)){DWORD n=need/sizeof(HMODULE);for(DWORD i=0;i<n&&i<512;i++){char nme[MAX_PATH]={0};if(GetModuleFileNameA(pe[i],nme,MAX_PATH)){const char*b=strrchr(nme,'\\');b=b?b+1:nme;if(strstr(b,"ScriptHook")||!_stricmp(b,"dinput8.dll")||!_stricmp(b,"ScriptHookV.dll"))logf("  module[%u]: %s @ %p",i,nme,(void*)pe[i]);}}}}for(int i=0;i<120&&g_running;i++){if(shv::load()){logf("ScriptHookV exports resolved OK");shv::registerScript(shvScriptMain);logf("scriptRegister called (fn=%p)",(void*)shvScriptMain);return;}if(i==0)logf("SHV not found initially (err=%u). Will retry.",(unsigned)GetLastError());Sleep(500);}logf("ScriptHookV not loadable after 60s.");
}
BOOL APIENTRY DllMain(HMODULE m,DWORD r,LPVOID){if(r==DLL_PROCESS_ATTACH){DisableThreadLibraryCalls(m);InitializeCriticalSection(&g_qCs);InitializeCriticalSection(&g_npCs);InitializeCriticalSection(&g_sendCs);g_pid=GetCurrentProcessId();char t[MAX_PATH];GetTempPathA(MAX_PATH,t);strcat_s(t,MAX_PATH,"gtamp_hook.log");fclose(fopen(t,"w"));logf("==== GTAMP hook v%s PID=%u ====",HOOK_VER,(unsigned)g_pid);HMODULE hm=GetModuleHandleA("GTA5.exe");if(!hm){logf("ERROR: GTA5.exe not found");return TRUE;}detectBuild(hm);shv::setLogger([](const char*s){logf("%s",s);});shv::setSelfHinst(m);CloseHandle(CreateThread(NULL,0,(LPTHREAD_START_ROUTINE)delayedShvLoad,NULL,0,NULL));g_ovT=CreateThread(NULL,0,overlayThread,NULL,0,NULL);g_netT=CreateThread(NULL,0,netThread,NULL,0,NULL);}else if(r==DLL_PROCESS_DETACH){g_running=false;if(g_ovT){WaitForSingleObject(g_ovT,3000);CloseHandle(g_ovT);}if(g_netT){WaitForSingleObject(g_netT,3000);CloseHandle(g_netT);}DeleteCriticalSection(&g_qCs);DeleteCriticalSection(&g_npCs);DeleteCriticalSection(&g_sendCs);logf("unloaded");}return TRUE;}
extern "C" __declspec(dllexport) const char* gtamp_version(){return "GTAMP Hook v" HOOK_VER;}
