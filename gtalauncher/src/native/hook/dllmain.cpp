/* GTAMP Hook v1.8.0 - Phase 6 remote players + Phase 7 chat + v1.8.0 FiveM-style join UX: in-game connect panel, F8 console (pre-SHV), T chat. */
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

#define HOOK_VER "1.9.0"
#define OVERLAY_KEY RGB(255,0,255)
#define OV_CLASS "GTAMP_OV160"
static volatile bool g_running=true;
static HANDLE g_ovT=NULL, g_netT=NULL;
static HWND g_ov=NULL, g_gta=NULL;
static DWORD g_pid=0;
static SOCKET g_sock=INVALID_SOCKET;
static bool g_vis=true;
static char g_ver[64]={0};
// v1.8.0 — FiveM-style in-game join panel + F8 console (works before SHV loads)
static bool g_joinActive=false, g_joinFailed=false;
static char g_joinServer[64]={0};
static char g_joinStage[96]={0};
// v1.9.0: incoming damage queue (net thread -> game fiber)
static int g_pendingDmg=0;
static char g_pendingDmgFrom[32]={0};
static DWORD g_joinT0=0;
static bool g_consoleOpen=false;
static char g_conInput[192]={0};
static int g_conInputLen=0;
#define CON_LOG_MAX 42
struct ConLine{char text[220]; unsigned char r,g,b;};
static ConLine g_conLog[CON_LOG_MAX];
static int g_conLogN=0;
static CRITICAL_SECTION g_conCs;
struct Vec3{float x,y,z;};
static uintptr_t g_base=0; static uint32_t g_size=0;
struct Found{bool found;uintptr_t ped;Vec3 pos;float heading;int hp;uintptr_t world;char why[128];char err[256];uint32_t tries;uint32_t cands;} g_f={0};
static bool g_shvReady=false;
static char g_shvMsg[256]={0};
static int g_shvSpawnCount=0;
static int g_netPedCount=0;
static int g_localTestBotStarted=0;
static int g_localTestBotPed=0;
static Vec3 g_shvLastPedCoords={0,0,0};
static float g_shvLastHeading=0.f;
static int g_localPed=0;
struct SpawnReq{char src[8];char model[64];float x,y,z,h;bool useOffset;int pedType;};
// Remote players (server-broadcast). NetPlayerId -> ped handle + state.
#define NET_PED_MAX 32
struct NetPed{
    int used;
    char id[32];          // "p12"
    char name[32];        // display name
    char model[64];
    int ped;              // entity handle
    int blip;             // map blip
    int serverId;         // numeric id for nametag (FiveM-style)
    Vec3 pos;             // network target
    Vec3 drawPos;         // interpolated render pos
    float h;              // target heading
    float drawH;          // interpolated heading
    float vx,vy,vz;
    int health, armour;
    int appliedHp;        // v1.9.0: last health value WE set (damage delta baseline)
    DWORD lastUpdate;
    int wantRespawn;      // model change: del entity but keep slot
    int spawnQueued;     // NQ_SPAWN already in flight
    int visible;
};
static NetPed g_netPeds[NET_PED_MAX];
// Ring-buffer queue so spawns that arrive before SHV ready are NOT dropped.
#define SPAWN_Q_SIZE 16
#define NQ_SPAWN 1
#define NQ_DEL   2
#define NQ_CLEAR 3
struct NpCmd{int op;char id[32];char name[32];char model[64];float x,y,z,h;};
#define NP_Q_SIZE 64
static void logf(const char* fmt,...); // forward decl
static void sendJson(const char* fmt,...); // forward decl (used by chat before def)
static void sstrcpy(char*dst,const char*src,size_t sz); // forward decl
static void pushConLine(const char* text, unsigned char r, unsigned char g, unsigned char b); // forward decl
static SpawnReq g_spawnQ[SPAWN_Q_SIZE];
static NpCmd g_npQ[NP_Q_SIZE];
static volatile LONG g_qHead=0,g_qTail=0;
static volatile LONG g_npHead=0,g_npTail=0;
static CRITICAL_SECTION g_qCs;
static CRITICAL_SECTION g_npCs;

// ---- Phase 7: F8 in-game chat ----
#define CHAT_LOG_MAX 8
#define CHAT_INPUT_MAX 200
struct ChatLine { char text[256]; DWORD born; unsigned char r,g,b; };
static ChatLine g_chatLog[CHAT_LOG_MAX];
static int g_chatLogN = 0;
static bool g_chatOpen = false;
static char g_chatInput[CHAT_INPUT_MAX+1] = {0};
static int g_chatInputLen = 0;
static DWORD g_chatOpenAt = 0;
static void pushChatLine(const char* text, unsigned char r=220, unsigned char g=220, unsigned char b=220){
    if(!text||!*text) return;
    if(g_chatLogN >= CHAT_LOG_MAX){
        memmove(&g_chatLog[0], &g_chatLog[1], sizeof(ChatLine)*(CHAT_LOG_MAX-1));
        g_chatLogN = CHAT_LOG_MAX-1;
    }
    ChatLine* L = &g_chatLog[g_chatLogN++];
    memset(L,0,sizeof(*L));
    { size_t i=0; for(;i+1<sizeof(L->text)&&text[i];i++) L->text[i]=text[i]; L->text[i]=0; }
    L->born = timeGetTime(); L->r=r; L->g=g; L->b=b;
    pushConLine(text, r, g, b); // mirror into the F8 console scrollback
}
// v1.8.0 — console ring buffer + command processor (FiveM-style F8)
static void pushConLine(const char* text, unsigned char r, unsigned char g, unsigned char b){
    if(!text||!*text) return;
    EnterCriticalSection(&g_conCs);
    if(g_conLogN >= CON_LOG_MAX){
        memmove(&g_conLog[0], &g_conLog[1], sizeof(ConLine)*(CON_LOG_MAX-1));
        g_conLogN = CON_LOG_MAX-1;
    }
    ConLine* L = &g_conLog[g_conLogN++];
    memset(L,0,sizeof(*L));
    { size_t i=0; for(;i+1<sizeof(L->text)&&text[i];i++) L->text[i]=text[i]; L->text[i]=0; }
    L->r=r; L->g=g; L->b=b;
    LeaveCriticalSection(&g_conCs);
}
static void runConsoleCommand(const char* raw){
    if(!raw||!*raw) return;
    char cmd[32]={0}, arg[160]={0};
    int i=0; const char*p=raw; while(*p==' ')p++;
    while(p[i] && p[i]!=' ' && i<31){ cmd[i]=p[i]; i++; } cmd[i]=0;
    while(p[i]==' ') i++;
    sstrcpy(arg, p+i, sizeof(arg));
    // sanitize arg so it can't break our JSON
    for(int k=0; arg[k]; k++){ if(arg[k]=='\"'||arg[k]=='\\'||arg[k]=='{'||arg[k]=='}') arg[k]=' '; }
    { char echo[240]; snprintf(echo,sizeof(echo),"> %s", raw); pushConLine(echo,150,150,155); }
    if(!_stricmp(cmd,"help")){
        pushConLine("commands: help · clear · connect <ip:port> · disconnect · quit · status · players · version · credit", 200,220,255);
    } else if(!_stricmp(cmd,"status")){
        int n=0; EnterCriticalSection(&g_npCs); for(int i=0;i<NET_PED_MAX;i++) if(g_netPeds[i].used) n++; LeaveCriticalSection(&g_npCs);
        char s[200]; snprintf(s,sizeof(s),"v%s · server: %s · %d remote player(s) · F8 console v%s",
            HOOK_VER, g_joinServer[0]?g_joinServer:"(not connected)", n, g_ver[0]?g_ver:"?");
        pushConLine(s,140,220,180);
    } else if(!_stricmp(cmd,"players")){
        EnterCriticalSection(&g_npCs);
        int n=0;
        for(int i=0;i<NET_PED_MAX;i++){ NetPed*np=&g_netPeds[i]; if(!np->used) continue; n++;
            char pl[120]; snprintf(pl,sizeof(pl),"[%d] %s — hp %d ar %d", np->serverId, np->name[0]?np->name:np->id, np->health, np->armour);
            pushConLine(pl,220,220,220);
        }
        LeaveCriticalSection(&g_npCs);
        if(!n) pushConLine("(no remote players in session)", 180,180,180);
    } else if(!_stricmp(cmd,"clear")){
        EnterCriticalSection(&g_conCs); g_conLogN=0; LeaveCriticalSection(&g_conCs);
    } else if(!_stricmp(cmd,"quit")){
        sendJson("{\"t\":\"consoleCmd\",\"cmd\":\"disconnect\"}");
        pushConLine("leaving session — returning to launcher…", 140,200,255);
        g_consoleOpen=false; g_conInput[0]=0; g_conInputLen=0;
    } else if(!_stricmp(cmd,"disconnect")){
        sendJson("{\"t\":\"consoleCmd\",\"cmd\":\"disconnect\"}");
        pushConLine("disconnecting from session…", 140,200,255);
    } else if(!_stricmp(cmd,"connect")){
        if(!arg[0]) pushConLine("usage: connect 127.0.0.1:22005", 255,180,120);
        else { sendJson("{\"t\":\"consoleCmd\",\"cmd\":\"connect\",\"arg\":\"%s\"}", arg); pushConLine("connecting…", 140,200,255); }
    } else if(!_stricmp(cmd,"version")){
        char v[96]; snprintf(v,sizeof(v),"GTAMP hook v%s — Rockstar-safe MP client", HOOK_VER); pushConLine(v,255,220,120);
    } else if(!_stricmp(cmd,"credit")){ pushConLine("GTAMP — our own netcode, no relation to FiveM/Cfx.re" , 200,200,200); }
    else {
        pushConLine("unknown command — type 'help'", 255,160,120);
    }
}
static void chatEscapeJson(const char* in, char* out, size_t outSz){
    size_t o=0;
    for(size_t i=0; in && in[i] && o+2<outSz; i++){
        char c=in[i];
        if(c=='\\' || c=='"'){ if(o+3>=outSz) break; out[o++]='\\'; out[o++]=c; }
        else if(c=='\n'||c=='\r'||c=='\t'){ out[o++]=' '; }
        else if((unsigned char)c < 32) continue;
        else out[o++]=c;
    }
    out[o]=0;
}
static void submitChat(){
    if(g_chatInputLen<=0){ g_chatOpen=false; g_chatInput[0]=0; g_chatInputLen=0; return; }
    // trim
    while(g_chatInputLen>0 && g_chatInput[g_chatInputLen-1]==' ') g_chatInput[--g_chatInputLen]=0;
    int start=0; while(g_chatInput[start]==' ') start++;
    if(!g_chatInput[start]){ g_chatOpen=false; g_chatInput[0]=0; g_chatInputLen=0; return; }
    char esc[CHAT_INPUT_MAX*2+8]; chatEscapeJson(g_chatInput+start, esc, sizeof(esc));
    sendJson("{\"t\":\"chat\",\"msg\":\"%s\"}", esc);
    logf("chat: sent '%s'", g_chatInput+start);
    g_chatOpen=false; g_chatInput[0]=0; g_chatInputLen=0;
}

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
static void removeBlip_SHV(NetPed*np){
    using namespace shv;
    if(!np || !np->blip) return;
    const uint64_t H_REMOVE_BLIP = 0x86A652570E5F25DDULL; // REMOVE_BLIP(Blip*)
    int b = np->blip;
    Invoker(H_REMOVE_BLIP).argp(&b).retv();
    np->blip = 0;
}
// hard=true frees the slot (player left). hard=false only deletes entity (model change / respawn).
static void deleteNetPed_SHV(NetPed*np, bool hard=true){
    using namespace shv;
    if(!np)return;
    const uint64_t H_DELETE_ENTITY=0xAE3CBE5BF394C9C9ULL;
    removeBlip_SHV(np);
    if(np->ped){
        Invoker(H_DELETE_ENTITY).argi(np->ped).argb(false).retv();
        wait(0);
        logf("netPed: deleted ped %d id=%s hard=%d",np->ped,np->id,(int)hard);
        np->ped=0;
    }
    if(hard){
        int idx=(int)(np-g_netPeds);
        if(idx>=0&&idx<NET_PED_MAX){memset(&g_netPeds[idx],0,sizeof(NetPed));g_netPedCount--;}
    } else {
        np->wantRespawn = 1;
    }
}
static int addPlayerBlip_SHV(int ped, const char* name){
    using namespace shv;
    if(!ped) return 0;
    // Only use stable blip natives. Blip-name text commands used a bad hash
    // (0xF9113A30F2C16B2A) that crashes SHV with "Can't find native".
    // Player names already show via drawNametags().
    const uint64_t H_ADD_BLIP = 0x5CDE92C702A8FCE7ULL; // ADD_BLIP_FOR_ENTITY
    const uint64_t H_SET_BLIP_SPRITE = 0xDF735600A4696DAFULL;
    const uint64_t H_SET_BLIP_COLOUR = 0x03D7FB09E75D6B7EULL;
    const uint64_t H_SET_BLIP_SCALE = 0xD38744167B2FA257ULL;
    const uint64_t H_SET_BLIP_AS_SHORT_RANGE = 0xBE8BE4FE60E27B72ULL;
    int blip = Invoker(H_ADD_BLIP).argi(ped).reti();
    if(!blip) return 0;
    Invoker(H_SET_BLIP_SPRITE).argi(blip).argi(1).retv(); // circle
    Invoker(H_SET_BLIP_COLOUR).argi(blip).argi(0).retv(); // white
    Invoker(H_SET_BLIP_SCALE).argi(blip).argf(0.85f).retv();
    Invoker(H_SET_BLIP_AS_SHORT_RANGE).argi(blip).argb(false).retv();
    (void)name;
    return blip;
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
                // FiveM-style remote clone: mission entity, no AI, no ragdoll panic,
                // collision on, not frozen solid (we drive coords via interpolation).
                const uint64_t H_BLOCK_EVENTS = 0x9F8AA94D6D97DBF4ULL; // SET_BLOCKING_OF_NON_TEMPORARY_EVENTS
                const uint64_t H_SET_CAN_RAGDOLL = 0xB128377056A54E2AULL; // SET_PED_CAN_RAGDOLL
                const uint64_t H_SET_RAGDOLL_ON_COLLISION = 0xF99F1F3B5A9D2E5EULL; // may no-op if hash wrong
                const uint64_t H_SET_COMBAT_ATTR = 0x9F7794730795E019ULL; // SET_PED_COMBAT_ATTRIBUTES
                const uint64_t H_SET_FLEE_ATTR = 0x70A2D1137C8ED7C9ULL; // SET_PED_FLEE_ATTRIBUTES
                const uint64_t H_SET_CAN_BE_TARGETTED = 0x63F58F7C80513AADULL; // SET_PED_CAN_BE_TARGETTED
                const uint64_t H_SET_CAN_BE_TARGETTED_BY_PLAYER = 0x4328652AE5769C71ULL;
                const uint64_t H_SET_ENTITY_COLLISION = 0x1A9205C1B9EE827FULL;
                const uint64_t H_SET_ENTITY_VISIBLE = 0xEA1C610A04DB6BBBULL;
                const uint64_t H_SET_PED_CONFIG_FLAG = 0x1913FE4CBF41C463ULL;
                const uint64_t H_TASK_STAND = 0x919BE13EED931959ULL; // TASK_STAND_STILL
                const uint64_t H_SET_PED_DIES_WHEN_INJURED = 0x5BA7919BED300023ULL;
                wait(30);
                Invoker(H_SET_MISSION).argi(np).argb(true).argb(true).retv();
                wait(0);
                Invoker(H_BLOCK_EVENTS).argi(np).argb(true).retv();
                wait(0);
                // Keep unfrozen so animation/look isn't locked; we still set coords each tick
                Invoker(H_FREEZE).argi(np).argb(false).retv();
                wait(0);
                Invoker(H_SET_INVINCIBLE).argi(np).argb(true).retv(); // damage lands in Phase 8
                wait(0);
                Invoker(H_SET_CAN_RAGDOLL).argi(np).argb(false).retv();
                wait(0);
                Invoker(H_SET_CAN_BE_TARGETTED).argi(np).argb(true).retv();
                wait(0);
                Invoker(H_SET_ENTITY_COLLISION).argi(np).argb(true).argb(false).retv();
                wait(0);
                Invoker(H_SET_ENTITY_VISIBLE).argi(np).argb(true).argb(false).retv();
                wait(0);
                // Disable ambient reactions / panic (config flags used by multiplayer clones)
                Invoker(H_SET_PED_CONFIG_FLAG).argi(np).argi(208).argb(true).retv(); // disable pain audio spam
                Invoker(H_SET_PED_CONFIG_FLAG).argi(np).argi(281).argb(true).retv(); // disable writhe
                wait(0);
                Invoker(H_SET_FLEE_ATTR).argi(np).argi(0).argb(false).retv();
                wait(0);
                Invoker(H_SET_COMBAT_ATTR).argi(np).argi(46).argb(false).retv();
                wait(0);
                Invoker(H_SET_COORDS).argi(np).argf(x).argf(y).argf(z).argb(false).argb(false).argb(false).retv();
                wait(0);
                Invoker(H_SET_HEADING).argi(np).argf(h).retv();
                wait(0);
                Invoker(H_TASK_STAND).argi(np).argi(86400000).retv();
                wait(30);
                logf("spawn: ped %d configured as FiveM-style remote clone @ %.1f,%.1f,%.1f h=%.1f",np,x,y,z,h);
            }
        }
        Invoker(H_SET_MODEL_NO).argh(m).retv();
    }
    return np;
}
static float lerpAng(float a, float b, float t){
    float d = fmodf(b - a + 540.f, 360.f) - 180.f;
    return a + d * t;
}
static void processNetPeds(DWORD now){
    using namespace shv;
    // SET_ENTITY_COORDS_NO_OFFSET keeps feet planted better for clones
    const uint64_t H_SET_COORDS_NO_OFFSET = 0x239A3351AC1DA385ULL; // SET_ENTITY_COORDS (same family; no-offset variant below)
    const uint64_t H_SET_COORDS = 0x239A3351AC1DA385ULL;
    const uint64_t H_SET_HEADING = 0x8E2530AA8ADA980EULL;
    const uint64_t H_DOES_ENTITY_EXIST = 0x7239B21A38F536BAULL;
    const uint64_t H_SET_ENTITY_VISIBLE = 0xEA1C610A04DB6BBBULL;
    const uint64_t H_IS_ENTITY_VISIBLE = 0x47D6F43D77935C75ULL;
    const float STREAM_IN = 300.f;   // FiveM-ish player scope (meters)
    const float STREAM_OUT = 320.f;
    float myx=g_shvLastPedCoords.x, myy=g_shvLastPedCoords.y, myz=g_shvLastPedCoords.z;
    for(int i=0;i<NET_PED_MAX;i++){
        NetPed*np=&g_netPeds[i];
        if(!np->used) continue;
        // Soft timeout — no net update (disconnect / stream drop)
        if(np->lastUpdate!=0 && now-np->lastUpdate>8000){
            logf("netPed: id=%s timed out — despawn (FiveM leave)", np->id);
            deleteNetPed_SHV(np, true);
            i--; continue;
        }
        float dx=np->pos.x-myx, dy=np->pos.y-myy, dz=np->pos.z-myz;
        float dist = sqrtf(dx*dx+dy*dy+dz*dz);
        // Stream out far players (hide + no tick) like FiveM entity culling
        if(dist > STREAM_OUT){
            if(np->ped && np->visible){
                Invoker(H_SET_ENTITY_VISIBLE).argi(np->ped).argb(false).argb(false).retv();
                np->visible = 0;
            }
            continue;
        }
        if(!np->ped){
            // Entity missing — request respawn once (debounce via wantRespawn flag)
            if(np->model[0] && g_shvReady && !np->spawnQueued){
                np->wantRespawn = 1;
                np->spawnQueued = 1;
                NpCmd c={0}; c.op=NQ_SPAWN;
                sstrcpy(c.id,np->id,sizeof(c.id));
                sstrcpy(c.name,np->name,sizeof(c.name));
                sstrcpy(c.model,np->model,sizeof(c.model));
                c.x=np->pos.x; c.y=np->pos.y; c.z=np->pos.z; c.h=np->h;
                queueNpCmd(&c);
                logf("net: auto-respawn queued id=%s", np->id);
            }
            continue;
        }
        int exists=Invoker(H_DOES_ENTITY_EXIST).argi(np->ped).reti();
        if(!exists){
            logf("netPed: id=%s ped vanished — will respawn", np->id);
            np->ped=0; np->blip=0; np->wantRespawn=1; continue;
        }
        if(dist < STREAM_IN && !np->visible){
            Invoker(H_SET_ENTITY_VISIBLE).argi(np->ped).argb(true).argb(false).retv();
            np->visible = 1;
        }
        // Smooth interpolation toward network target (FiveM-style client blend)
        // alpha ~0.25 at 60fps feels responsive without rubber-banding hard
        const float a = 0.28f;
        np->drawPos.x += (np->pos.x - np->drawPos.x) * a;
        np->drawPos.y += (np->pos.y - np->drawPos.y) * a;
        np->drawPos.z += (np->pos.z - np->drawPos.z) * a;
        np->drawH = lerpAng(np->drawH, np->h, a);
        // Snap if teleported far
        float tdx=np->pos.x-np->drawPos.x, tdy=np->pos.y-np->drawPos.y, tdz=np->pos.z-np->drawPos.z;
        if(tdx*tdx+tdy*tdy+tdz*tdz > 25.f*25.f){
            np->drawPos = np->pos;
            np->drawH = np->h;
        }
        Invoker(H_SET_COORDS).argi(np->ped).argf(np->drawPos.x).argf(np->drawPos.y).argf(np->drawPos.z)
            .argb(false).argb(false).argb(false).retv();
        Invoker(H_SET_HEADING).argi(np->ped).argf(np->drawH).retv();
        (void)H_SET_COORDS_NO_OFFSET;
        (void)H_IS_ENTITY_VISIBLE;
        // ---- v1.9.0: health/armour sync + basic damage (FiveM-style, owner-authoritative) ----
        {
            const uint64_t H_GET_HEALTH  = 0xEEF059A8E6C27644ULL; // GET_ENTITY_HEALTH
            const uint64_t H_SET_HEALTH  = 0x6B76DC1F3AE6E6A8ULL; // SET_ENTITY_HEALTH
            const uint64_t H_DAMAGED_BY  = 0xC86D67D52A707CF8ULL; // HAS_ENTITY_BEEN_DAMAGED_BY_ENTITY
            const uint64_t H_GET_ARMOUR  = 0x9483AF821605B1D8ULL; // GET_PED_ARMOUR
            const uint64_t H_SET_ARMOUR  = 0xCEBA04A519F17003ULL; // SET_PED_ARMOUR
            const uint64_t H_IS_DEAD     = 0x3317DEDB88C95038ULL; // IS_PED_DEAD_OR_DYING
            int curHp = Invoker(H_GET_HEALTH).argi(np->ped).reti();
            int isDead = Invoker(H_IS_DEAD).argi(np->ped).argb(true).reti();
            int wantHp = np->health > 0 ? np->health : 200;
            // 1) local player damaging this remote clone -> report delta to the clone's owner
            if(!isDead && g_localPed){
                int dmgByMe = Invoker(H_DAMAGED_BY).argi(np->ped).argi(g_localPed).argb(true).reti();
                if(dmgByMe){
                    int base = np->appliedHp > 0 ? np->appliedHp : wantHp;
                    int delta = base - curHp;
                    if(delta > 0 && delta < 500){
                        sendJson("{\"t\":\"hit\",\"id\":\"%s\",\"d\":%d}", np->id, delta);
                        char hl[128]; snprintf(hl,sizeof(hl),"You hit %s (-%d)", np->name[0]?np->name:np->id, delta);
                        pushChatLine(hl,255,200,140);
                        logf("dmg: local hit %s -%d (%d->%d)", np->id, delta, base, curHp);
                    }
                }
            }
            // 2) mirror the owner's authoritative health/armour onto the clone
            if(wantHp < 100){
                // owner died -> kill the clone (death sync)
                if(!isDead){ Invoker(H_SET_HEALTH).argi(np->ped).argi(0).argi(0).argi(0).retv(); np->appliedHp = 0; }
            } else {
                if(!isDead && curHp != wantHp){ Invoker(H_SET_HEALTH).argi(np->ped).argi(wantHp).argi(0).argi(0).retv(); }
                np->appliedHp = wantHp;
            }
            int curAr = Invoker(H_GET_ARMOUR).argi(np->ped).reti();
            if(np->armour >= 0 && curAr != np->armour){ Invoker(H_SET_ARMOUR).argi(np->ped).argi(np->armour).retv(); }
            // 3) clone ended up dead but its owner is alive -> fresh clone at the target pos
            if(isDead && wantHp >= 100){
                logf("net: clone died but owner alive id=%s -> respawn clone", np->id);
                np->ped = 0; np->blip = 0; np->wantRespawn = 1; np->spawnQueued = 0; np->appliedHp = 0;
            }
        }
    }
}
// GET_SCREEN_COORD_FROM_WORLD_COORD — push two float* outs via Invoker::argp
static bool worldToScreen(float x, float y, float z, float* sx, float* sy){
    using namespace shv;
    const uint64_t H_W2S = 0x34E82F05DF2974F5ULL;
    float ox=0.f, oy=0.f;
    int ok = Invoker(H_W2S).argf(x).argf(y).argf(z).argp(&ox).argp(&oy).reti();
    if(sx) *sx = ox; if(sy) *sy = oy;
    return ok != 0;
}
static void drawText2d(const char* msg, float x, float y, float scale, int r, int g, int b, int a, bool centre){
    using namespace shv;
    if(!msg||!*msg) return;
    const uint64_t H_SET_SCALE = 0x07C837F9A01C34C9ULL;
    const uint64_t H_SET_COLOUR = 0xBE6B23FFA53FB442ULL;
    const uint64_t H_SET_CENTRE = 0xC02F4DBFB51D988BULL;
    const uint64_t H_SET_OUTLINE = 0x2513DFB0FB8400FEULL;
    const uint64_t H_SET_FONT = 0x66E0276CC5F6B9DAULL;
    const uint64_t H_SET_WRAP = 0x63145D9C883A1A70ULL;
    const uint64_t H_BEGIN = 0x25FBB336DF1804CBULL;
    const uint64_t H_ADD = 0x6C188BE134E074AAULL;
    const uint64_t H_END = 0xCD015E5BB0D96A57ULL;
    Invoker(H_SET_FONT).argi(4).retv();
    Invoker(H_SET_SCALE).argf(scale).argf(scale).retv();
    Invoker(H_SET_COLOUR).argi(r).argi(g).argi(b).argi(a).retv();
    Invoker(H_SET_CENTRE).argb(centre).retv();
    Invoker(H_SET_OUTLINE).retv();
    Invoker(H_SET_WRAP).argf(0.0f).argf(1.0f).retv();
    Invoker(H_BEGIN).argp((void*)"STRING").retv();
    Invoker(H_ADD).argp((void*)msg).retv();
    Invoker(H_END).argf(x).argf(y).retv();
}
// Phase 6: FiveM-style nametags — "[id] name" above head, distance scaled, LOS-ish range
static void drawNametags(){
    float myx=g_shvLastPedCoords.x, myy=g_shvLastPedCoords.y, myz=g_shvLastPedCoords.z;
    for(int i=0;i<NET_PED_MAX;i++){
        NetPed*np=&g_netPeds[i];
        if(!np->used || !np->name[0]) continue;
        if(!np->visible && np->ped) continue;
        Vec3 p = (np->drawPos.x!=0.f||np->drawPos.y!=0.f||np->drawPos.z!=0.f) ? np->drawPos : np->pos;
        if(p.x==0.f && p.y==0.f && p.z==0.f) continue;
        float wx=p.x, wy=p.y, wz=p.z + 1.0f;
        float dx=wx-myx, dy=wy-myy, dz=wz-myz;
        float dist2=dx*dx+dy*dy+dz*dz;
        // FiveM default nametag range is roughly speaking distance (~25m tight, we allow 40m)
        if(dist2 > 40.f*40.f) continue;
        float sx=0.f, sy=0.f;
        if(!worldToScreen(wx,wy,wz,&sx,&sy)) continue;
        if(sx < -0.05f || sx > 1.05f || sy < -0.05f || sy > 1.05f) continue;
        float dist = sqrtf(dist2);
        float scale = dist < 8.f ? 0.40f : (dist < 20.f ? 0.34f : 0.28f);
        int hp = np->health > 0 ? np->health : 200;
        // White name like FiveM; slight health tint only when hurt
        int r=255, g=255, b=255;
        if(hp < 100){ r=255; g=160; b=160; }
        else if(hp < 150){ r=255; g=230; b=180; }
        char label[64];
        if(np->serverId > 0)
            snprintf(label, sizeof(label), "[%d] %s", np->serverId, np->name);
        else
            snprintf(label, sizeof(label), "%s", np->name);
        int a = np->ped ? 240 : 170;
        drawText2d(label, sx, sy, scale, r, g, b, a, true);
        // Talking / health under-bar approximation: thin second line with HP%
        if(dist < 25.f){
            char sub[32];
            // GTA alive range is 100..200 — map onto 0..100% (v1.9.0 fix)
            int pct = hp <= 100 ? 0 : (hp >= 200 ? 100 : (((hp - 100) * 100) / 100));
            snprintf(sub, sizeof(sub), "HP %d%%", pct);
            drawText2d(sub, sx, sy + 0.018f, scale * 0.75f, 180, 220, 180, a - 40, true);
        }
    }
}
// Phase 7: recent chat lines + F8 input box
static void drawChatUI(){
    DWORD now = timeGetTime();
    float y = 0.70f;
    for(int i=0;i<g_chatLogN;i++){
        ChatLine* L=&g_chatLog[i];
        if(!g_chatOpen && (now - L->born > 12000)) continue;
        drawText2d(L->text, 0.02f, y, 0.35f, L->r, L->g, L->b, 230, false);
        y += 0.024f;
    }
    if(g_chatOpen){
        char buf[CHAT_INPUT_MAX+8];
        snprintf(buf, sizeof(buf), "> %s_", g_chatInput);
        drawText2d(buf, 0.02f, 0.93f, 0.40f, 255, 255, 120, 255, false);
        drawText2d("T chat | Enter send | Esc cancel · F8 console", 0.02f, 0.96f, 0.28f, 180, 180, 180, 200, false);
    }
}


// Solo / FiveM-style: if no remote players after SHV ready, spawn a local clone ped
// so the player always sees "another player" without depending on TCP timing.
static void ensureLocalTestBot_SHV(){
    using namespace shv;
    if(g_localTestBotStarted) return;
    if(!g_shvReady || !g_localPed) return;
    // Prefer network-driven bots if any already exist
    if(g_netPedCount > 0) { g_localTestBotStarted = 1; return; }
    float x=g_shvLastPedCoords.x, y=g_shvLastPedCoords.y, z=g_shvLastPedCoords.z, h=g_shvLastHeading;
    if((x==0.f && y==0.f) || z < 1.f) return; // wait for valid coords
    g_localTestBotStarted = 1;
    // Offset 4m in front of local player
    float rad = h * 0.01745329252f;
    float bx = x + sinf(rad) * 4.f;
    float by = y + cosf(rad) * 4.f;
    float bz = z;
    logf("localTestBot: spawning FiveM-style clone ahead at %.1f,%.1f,%.1f", bx, by, bz);
    // Use freemode first; fall back to cop (known-good on this machine)
    const char* models[] = { "mp_m_freemode_01", "s_m_y_cop_01" };
    int ped = 0;
    for(int mi=0; mi<2 && !ped; mi++){
        ped = doSpawnPed(models[mi], bx, by, bz, h, 4, true, "[TestBot]");
        if(!ped) logf("localTestBot: model %s failed, trying next", models[mi]);
    }
    if(!ped){
        logf("localTestBot: ALL SPAWNS FAILED");
        g_localTestBotStarted = 0; // retry later
        return;
    }
    // Register as net ped so nametag/processNetPeds track it
    NetPed* np = allocNetPed();
    if(np){
        sstrcpy(np->id, "p9001", sizeof(np->id));
        sstrcpy(np->name, "TestBot", sizeof(np->name));
        sstrcpy(np->model, "mp_m_freemode_01", sizeof(np->model));
        np->ped = ped;
        np->pos.x=bx; np->pos.y=by; np->pos.z=bz; np->h=h;
        np->drawPos=np->pos; np->drawH=h;
        np->health=200; np->serverId=9001; np->visible=1;
        np->lastUpdate=timeGetTime();
        np->blip = addPlayerBlip_SHV(ped, "TestBot");
        g_localTestBotPed = ped;
        logf("localTestBot: OK ped=%d blip=%d (netPeds=%d)", ped, np->blip, g_netPedCount);
        sendJson("{\"t\":\"netPedSpawned\",\"id\":\"p9001\",\"ped\":%d,\"name\":\"TestBot\"}", ped);
        pushChatLine("+ TestBot connected", 140, 200, 255);
    } else {
        logf("localTestBot: net ped table full");
    }
}
// Walk TestBot in a circle around the local player each tick (solo demo)
static void tickLocalTestBot_SHV(DWORD now){
    using namespace shv;
    if(!g_localTestBotPed || !g_localPed) return;
    NetPed* np = findNetPed("p9001");
    if(!np || !np->ped) return;
    // If network is driving this id with fresh updates, don't override
    // (lastUpdate refreshed by net < 500ms ago and we got external packets)
    static float ang = 0.f;
    ang += 0.04f;
    float x=g_shvLastPedCoords.x, y=g_shvLastPedCoords.y, z=g_shvLastPedCoords.z;
    np->pos.x = x + cosf(ang) * 5.f;
    np->pos.y = y + sinf(ang) * 5.f;
    np->pos.z = z;
    np->h = ang * 57.2957795f + 90.f;
    while(np->h >= 360.f) np->h -= 360.f;
    while(np->h < 0.f) np->h += 360.f;
    np->lastUpdate = now;
    // processNetPeds will lerp/set coords
}

static void __cdecl shvScriptMain(){
    logf("SHV scriptMain: entered (v" HOOK_VER ")");using namespace shv;
    const uint64_t H_PLAYER_ID=0x4F8644AF03D0E0D6ULL,H_PPID=0xD80958FC74E988A6ULL,H_GEC=0x3FEF770D40960D5AULL,H_GEH=0xE83D4F9BA2A38914ULL;
    wait(5000);logf("SHV: initial 5s wait done.");int pidx=0;DWORD lastTick=0,lastPosSend=0,lastNetTick=0;DWORD t0=timeGetTime();
    while(g_running){wait(0);DWORD now=timeGetTime();
        if(!g_localPed){static DWORD lt=0;if(now-lt>500){lt=now;pidx=Invoker(H_PLAYER_ID).reti();int p=Invoker(H_PPID).reti();if(p&&timeGetTime()-t0>8000){g_localPed=p;g_shvReady=true;logf("SHV READY: playerIdx=%d ped=0x%X (uptime=%ums) netPeds=%d",pidx,p,(unsigned)(timeGetTime()-t0),g_netPedCount);strcpy_s(g_f.err,"Scanning mem for ped...");sendJson("{\"t\":\"ready\",\"ped\":%d,\"uptime\":%lu}",p,(unsigned long)(timeGetTime()-t0));if(g_gta&&IsWindow(g_gta)){SetForegroundWindow(g_gta);logf("brought GTA window to front");}}else{static DWORD ll=0;if(now-ll>3000){ll=now;logf("SHV: waiting for ped... t=%ums p=%d",(unsigned)(timeGetTime()-t0),p);}}}continue;}
        // Apply remote-ped movement every tick (smooth)
        if(now-lastNetTick>16){lastNetTick=now;processNetPeds(now);tickLocalTestBot_SHV(now);}
        // v1.9.0: incoming damage from remote players (armour soaks first, GTA semantics)
        {
            int d=0; char from[32]={0};
            EnterCriticalSection(&g_conCs);
            if(g_pendingDmg>0){ d=g_pendingDmg; g_pendingDmg=0; sstrcpy(from,g_pendingDmgFrom,sizeof(from)); g_pendingDmgFrom[0]=0; }
            LeaveCriticalSection(&g_conCs);
            if(d>0){
                const uint64_t H_GET_HEALTH=0xEEF059A8E6C27644ULL,H_SET_HEALTH=0x6B76DC1F3AE6E6A8ULL,H_GET_ARMOUR=0x9483AF821605B1D8ULL,H_SET_ARMOUR=0xCEBA04A519F17003ULL,H_IS_DEAD=0x3317DEDB88C95038ULL;
                int dead=Invoker(H_IS_DEAD).argi(g_localPed).argb(true).reti();
                if(!dead){
                    int ar=Invoker(H_GET_ARMOUR).argi(g_localPed).reti();
                    int soak=ar<d?ar:d;
                    if(soak>0) Invoker(H_SET_ARMOUR).argi(g_localPed).argi(ar-soak).retv();
                    int hp=Invoker(H_GET_HEALTH).argi(g_localPed).reti();
                    int want=hp-(d-soak);
                    if(want<100) want=0; // GTA: ped health 100..200 alive, below 100 = death
                    Invoker(H_SET_HEALTH).argi(g_localPed).argi(want).argi(0).argi(0).retv();
                    char dl[128]; snprintf(dl,sizeof(dl),"%s hit you (-%d)", from[0]?from:"player", d);
                    pushChatLine(dl,255,120,120);
                    logf("dmg: took %d from %s (hp %d->%d, armour soak %d)", d, from, hp, want, soak);
                }
            }
        }
        // FiveM-style: ensure a visible remote clone exists for solo testing
        static DWORD lastBotTry=0;
        if(g_shvReady && !g_localTestBotStarted && now-lastBotTry>1000){
            lastBotTry=now; ensureLocalTestBot_SHV();
        }
        // v1.9.0 — FiveM behavior: never sit on a loading screen once we control the game.
        // SHUTDOWN_LOADING_SCREEN for the first 15s post-ready clears story-mode splash/loading cards.
        {
            static DWORD killUntil=0;
            if(g_shvReady && !killUntil) killUntil = now + 15000;
            if(killUntil && now < killUntil){
                static DWORD lk=0; if(now-lk>250){ lk=now; Invoker(0x078EBE9809CCD637ULL).retv(); } // SHUTDOWN_LOADING_SCREEN
            }
        }
        // Phase 6+7: nametags + chat HUD every frame (text natives are cheap)
        drawNametags();
        drawChatUI();
        // F8 (console) or T (chat, like FiveM) opens chat input — edge-triggered.
        // Works during server loading too: hook thread is independent of the game.
        {
            // v1.8.0: F8 = console (owned by the overlay thread, works pre-SHV). T = chat (FiveM-style), suppressed while console is open.
            static bool tWas=false, escWas=false, retWas=false, bkWas=false;
            bool tk = (GetAsyncKeyState(0x54) & 0x8000) != 0; // 'T'
            if(!g_consoleOpen && !g_chatOpen && tk && !tWas){
                g_chatOpen = true; g_chatOpenAt=now; g_chatInput[0]=0; g_chatInputLen=0; logf("chat: opened (T)");
            }
            tWas=tk;
            if(g_consoleOpen && g_chatOpen) g_chatOpen=false;
            if(g_chatOpen){
                bool esc=(GetAsyncKeyState(VK_ESCAPE)&0x8000)!=0;
                if(esc && !escWas){ g_chatOpen=false; g_chatInput[0]=0; g_chatInputLen=0; }
                escWas=esc;
                bool ret=(GetAsyncKeyState(VK_RETURN)&0x8000)!=0;
                if(ret && !retWas){ submitChat(); }
                retWas=ret;
                bool bk=(GetAsyncKeyState(VK_BACK)&0x8000)!=0;
                if(bk && !bkWas && g_chatInputLen>0){ g_chatInput[--g_chatInputLen]=0; }
                bkWas=bk;
                // Poll printable keys A-Z, 0-9, space, basic punct via GetAsyncKeyState
                // Use ToUnicode for proper chars when possible
                static SHORT prev[256]; 
                for(int vk=8; vk<256; vk++){
                    if(vk==VK_F8||vk==VK_ESCAPE||vk==VK_RETURN||vk==VK_BACK||vk==VK_SHIFT||vk==VK_CONTROL||vk==VK_MENU||vk==VK_LWIN||vk==VK_RWIN) continue;
                    SHORT st = GetAsyncKeyState(vk);
                    bool down = (st & 0x8000)!=0;
                    bool was = (prev[vk] & 0x8000)!=0;
                    prev[vk]=st;
                    if(!(down && !was)) continue;
                    // translate
                    BYTE kb[256]; GetKeyboardState(kb);
                    // force key down bit for ToUnicode
                    WCHAR chars[4]={0};
                    int n = ToUnicode((UINT)vk, MapVirtualKeyA((UINT)vk, MAPVK_VK_TO_VSC), kb, chars, 4, 0);
                    if(n<=0) continue;
                    for(int ci=0; ci<n; ci++){
                        wchar_t wc=chars[ci];
                        if(wc < 32 || wc > 126) continue; // basic ASCII chat
                        if(g_chatInputLen >= CHAT_INPUT_MAX) break;
                        g_chatInput[g_chatInputLen++] = (char)wc;
                        g_chatInput[g_chatInputLen]=0;
                    }
                }
            }
        }
        // Drain net-ped command queue (spawn/del/clear) — SHV fiber ONLY, one cmd per tick.
        EnterCriticalSection(&g_npCs);
        bool hasNp=(g_npTail!=g_npHead);
        NpCmd nc={0};
        if(hasNp){LONG h=g_npHead;int idx=((int)h)&(NP_Q_SIZE-1);nc=g_npQ[idx];g_npHead=h+1;}
        LeaveCriticalSection(&g_npCs);
        if(hasNp){
            if(nc.op==NQ_SPAWN){
                NetPed*np=findNetPed(nc.id);
                if(!np){
                    // Slot may have been wiped; recreate bookkeeping
                    np=allocNetPed();
                    if(np){ sstrcpy(np->id,nc.id,sizeof(np->id)); }
                }
                if(!np){ logf("net: SPAWN drop id=%s (table full)", nc.id); }
                else if(np->ped && !np->wantRespawn){
                    // Already have clone — refresh target pose (FiveM entity update)
                    np->pos.x=nc.x; np->pos.y=nc.y; np->pos.z=nc.z; np->h=nc.h;
                    if(np->drawPos.x==0&&np->drawPos.y==0&&np->drawPos.z==0){ np->drawPos=np->pos; np->drawH=np->h; }
                    if(nc.name[0]) sstrcpy(np->name,nc.name,sizeof(np->name));
                    if(nc.model[0]) sstrcpy(np->model,nc.model,sizeof(np->model));
                    np->lastUpdate=timeGetTime();
                } else {
                    // Create FiveM-style remote player ped
                    if(np->ped && np->wantRespawn){
                        deleteNetPed_SHV(np, false); // entity only
                    }
                    char tag[64];snprintf(tag,sizeof(tag),"[player %s]",nc.id);
                    if(nc.name[0]) sstrcpy(np->name,nc.name,sizeof(np->name));
                    if(nc.model[0]) sstrcpy(np->model,nc.model,sizeof(np->model));
                    np->pos.x=nc.x; np->pos.y=nc.y; np->pos.z=nc.z; np->h=nc.h;
                    np->drawPos=np->pos; np->drawH=np->h;
                    // Parse server id from "p12"
                    if(np->serverId<=0 && nc.id[0]=='p') np->serverId = atoi(nc.id+1);
                    int ped=doSpawnPed(np->model[0]?np->model:"mp_m_freemode_01",nc.x,nc.y,nc.z,nc.h,4,true,tag);
                    if(ped){
                        np->ped=ped; np->wantRespawn=0; np->spawnQueued=0; np->visible=1; g_shvSpawnCount++;
                        np->blip = addPlayerBlip_SHV(ped, np->name);
                        np->lastUpdate=timeGetTime();
                        logf("net: FiveM SPAWN id=%s name=%s sid=%d -> ped=%d blip=%d",nc.id,np->name,np->serverId,ped,np->blip);
                        sendJson("{\"t\":\"netPedSpawned\",\"id\":\"%s\",\"ped\":%d,\"name\":\"%s\"}",nc.id,ped,np->name);
                        {char jl[96];snprintf(jl,sizeof(jl),"+ %s joined", np->name[0]?np->name:nc.id);pushChatLine(jl,140,200,255);}
                    } else { np->spawnQueued=0; logf("net: FiveM FAILED spawn id=%s model=%s",nc.id,np->model); }
                }
            }else if(nc.op==NQ_DEL){
                NetPed*np=findNetPed(nc.id);
                if(np){
                    // wantRespawn means model swap — soft delete. Else player left.
                    bool hard = !np->wantRespawn;
                    if(hard){
                        char jl[96];snprintf(jl,sizeof(jl),"- %s left", np->name[0]?np->name:np->id);
                        pushChatLine(jl,255,160,120);
                    }
                    deleteNetPed_SHV(np, hard);
                    if(!hard) np->wantRespawn = 1; // keep flag for following SPAWN
                }
            }else if(nc.op==NQ_CLEAR){
                logf("net: clearing all remote players (%d)",g_netPedCount);
                for(int i=0;i<NET_PED_MAX;i++){
                    if(!g_netPeds[i].used) continue;
                    deleteNetPed_SHV(&g_netPeds[i], true);
                    i--;
                }
            }
            wait(0);
        }
        // Read local pos @ ~20Hz, send to bridge @ ~10Hz
        if(now-lastTick>50){lastTick=now;float x=0,y=0,z=0,h=0;Invoker(H_GEC).argi(g_localPed).argb(true).ret3f(x,y,z);h=Invoker(H_GEH).argi(g_localPed).retf();if(x||y||z){g_shvLastPedCoords.x=x;g_shvLastPedCoords.y=y;g_shvLastPedCoords.z=z;g_shvLastHeading=h;}static DWORD ll=0;if(now-ll>5000){ll=now;logf("SHV tick: pos=%.1f,%.1f,%.1f h=%.1f netPeds=%d",x,y,z,h,g_netPedCount);}if(now-lastPosSend>100){lastPosSend=now;int mhp=Invoker(0xEEF059A8E6C27644ULL).argi(g_localPed).reti(),mar=Invoker(0x9483AF821605B1D8ULL).argi(g_localPed).reti();sendJson("{\"t\":\"pos\",\"x\":%.3f,\"y\":%.3f,\"z\":%.3f,\"h\":%.2f,\"ped\":%d,\"health\":%d,\"armour\":%d}",x,y,z,h,g_localPed,mhp,mar);}}
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
static void ovText(HDC dc, HFONT f, int x, int y, const char* s, COLORREF c){
    SelectObject(dc,f); SetTextColor(dc,c); TextOutA(dc,x,y,s,(int)strlen(s));
}
// v1.8.0 — overlay painter priority: F8 console > join panel > debug HUD (F9)
static LRESULT CALLBACK wndProc(HWND w,UINT m,WPARAM a,LPARAM b){
    if(m==WM_PAINT){
        PAINTSTRUCT ps; HDC dc=BeginPaint(w,&ps);
        HBRUSH kb=CreateSolidBrush(OVERLAY_KEY); RECT rc; GetClientRect(w,&rc); FillRect(dc,&rc,kb); DeleteObject(kb);
        SetBkMode(dc,TRANSPARENT);
        int W=rc.right-rc.left, H=rc.bottom-rc.top;
        HFONT fT=CreateFontA(30,0,0,0,FW_BOLD,0,0,0,DEFAULT_CHARSET,0,0,CLEARTYPE_QUALITY,0,"Segoe UI");
        HFONT fH=CreateFontA(22,0,0,0,FW_BOLD,0,0,0,DEFAULT_CHARSET,0,0,CLEARTYPE_QUALITY,0,"Segoe UI");
        HFONT fN=CreateFontA(15,0,0,0,FW_NORMAL,0,0,0,DEFAULT_CHARSET,0,0,CLEARTYPE_QUALITY,0,"Segoe UI");
        HFONT fS=CreateFontA(13,0,0,0,FW_NORMAL,0,0,0,DEFAULT_CHARSET,0,0,CLEARTYPE_QUALITY,0,"Segoe UI");
        if(g_consoleOpen){
            int ch=H*55/100;
            RECT cr={0,0,W,ch}; HBRUSH pb=CreateSolidBrush(RGB(13,14,17)); FillRect(dc,&cr,pb); DeleteObject(pb);
            HPEN pn=CreatePen(PS_SOLID,2,RGB(244,5,82)); HGDIOBJ po=SelectObject(dc,pn);
            MoveToEx(dc,0,ch-1,NULL); LineTo(dc,W,ch-1); SelectObject(dc,po); DeleteObject(pn);
            ovText(dc,fT,20,12,"GTAMP",RGB(244,5,82));
            ovText(dc,fH,128,20,"CONSOLE",RGB(240,240,240));
            ovText(dc,fS,W<300?20:W-260,26,"[F8] close · type 'help'",RGB(150,150,160));
            int maxLines=(ch-90)/17; if(maxLines<1)maxLines=1;
            int count=g_conLogN<maxLines?g_conLogN:maxLines;
            EnterCriticalSection(&g_conCs);
            for(int i=0;i<count;i++){
                ConLine*L=&g_conLog[g_conLogN-count+i];
                ovText(dc,fN,20,56+i*17,L->text,RGB(L->r,L->g,L->b));
            }
            LeaveCriticalSection(&g_conCs);
            char ib[224]; bool blink=((timeGetTime()/500)&1)!=0;
            snprintf(ib,sizeof(ib),"> %s%s", g_conInput, blink?"_":" ");
            ovText(dc,fN,20,ch-30,ib,RGB(255,255,120));
        }
        else if(g_joinActive){
            int cw=(W<600)?W-40:560, chh=300;
            int cx=(W-cw)/2, cy=(H-chh)/3; if(cy<8)cy=8;
            RECT card={cx,cy,cx+cw,cy+chh}; HBRUSH cb2=CreateSolidBrush(RGB(15,16,20)); FillRect(dc,&card,cb2); DeleteObject(cb2);
            RECT bar={cx,cy,cx+cw,cy+4}; HBRUSH bb2=CreateSolidBrush(RGB(244,5,82)); FillRect(dc,&bar,bb2); DeleteObject(bb2);
            ovText(dc,fT,cx+28,cy+26,"GTAMP",RGB(244,5,82));
            ovText(dc,fS,cx+28,cy+58,g_joinFailed?"CONNECTION FAILED":"CONNECTING",RGB(150,150,160));
            ovText(dc,fH,cx+28,cy+92,g_joinServer[0]?g_joinServer:"GTAMP Server",RGB(240,240,240));
            static const char* dots[4]={".   ","..  ","... ","    "};
            char st[128]; snprintf(st,sizeof(st),"%s%s", g_joinStage, g_joinFailed?"":dots[(timeGetTime()/350)%4]);
            ovText(dc,fN,cx+28,cy+128,st,g_joinFailed?RGB(255,110,110):RGB(200,205,215));
            int el=(int)((timeGetTime()-g_joinT0)/1000);
            char et[64]; snprintf(et,sizeof(et),"%ds elapsed",el);
            ovText(dc,fS,cx+28,cy+152,et,RGB(120,125,135));
            if(g_joinFailed) ovText(dc,fS,cx+28,cy+180,"Retry from the GTAMP launcher window",RGB(255,200,80));
            else ovText(dc,fS,cx+28,cy+180,"GTAMP keeps running in the background",RGB(120,125,135));
            ovText(dc,fS,cx+28,cy+chh-46,"F8 console · T chat in game",RGB(140,140,150));
            int bw=cw-56, seg=bw/8; if(seg<6)seg=6;
            int on=(int)((timeGetTime()/180)%8);
            for(int i2=0;i2<8;i2++){
                RECT sg={cx+28+i2*seg,cy+chh-24,cx+28+i2*seg+seg-6,cy+chh-18};
                HBRUSH sb=CreateSolidBrush(g_joinFailed?RGB(60,30,30):(i2<=on?RGB(244,5,82):RGB(35,36,42)));
                FillRect(dc,&sg,sb); DeleteObject(sb);
            }
        }
        else if(g_vis){
            RECT br={8,8,700,240}; HBRUSH b2=CreateSolidBrush(RGB(18,10,2)); FillRect(dc,&br,b2); DeleteObject(b2);
            HPEN pn=CreatePen(PS_SOLID,1,RGB(244,5,82)); HGDIOBJ po=SelectObject(dc,pn);
            MoveToEx(dc,br.left,br.top,NULL); LineTo(dc,br.right,br.top); LineTo(dc,br.right,br.bottom); LineTo(dc,br.left,br.bottom); LineTo(dc,br.left,br.top);
            SelectObject(dc,po); DeleteObject(pn);
            ovText(dc,fH,20,16,"GTAMP debug HUD",RGB(244,5,82));
            char ln[320];
            snprintf(ln,sizeof(ln),"v%s · build %s · F9 HUD off",HOOK_VER,g_ver[0]?g_ver:"?");
            ovText(dc,fS,20,44,ln,RGB(220,224,232));
            if(shv::loaded()){
                COLORREF c=g_shvReady?RGB(120,220,120):RGB(255,200,80);
                snprintf(ln,sizeof(ln),"ScriptHookV: OK  script=%s  spawns=%d  remotePeds=%d",g_shvReady?"ready":"starting",g_shvSpawnCount,g_netPedCount);
                ovText(dc,fS,20,64,ln,c);
            } else ovText(dc,fS,20,64,"ScriptHookV.dll NOT FOUND",RGB(255,160,80));
            if(g_shvReady&&g_f.found){
                snprintf(ln,sizeof(ln),"pos: %.1f,%.1f,%.1f  h=%.1f  bridge: %s",g_shvLastPedCoords.x,g_shvLastPedCoords.y,g_shvLastPedCoords.z,g_shvLastHeading,g_sock!=INVALID_SOCKET?"connected":"waiting");
                ovText(dc,fS,20,88,ln,RGB(180,255,180));
                int yy=112;
                for(int i2=0;i2<NET_PED_MAX && yy<232;i2++){
                    if(!g_netPeds[i2].used) continue;
                    snprintf(ln,sizeof(ln),"  %s  ped=%d  hp=%d", g_netPeds[i2].name[0]?g_netPeds[i2].name:g_netPeds[i2].id, g_netPeds[i2].ped, g_netPeds[i2].health);
                    ovText(dc,fS,20,yy,ln,RGB(200,220,255)); yy+=15;
                }
                if(yy<120) ovText(dc,fS,20,108,"(no remote players yet)",RGB(150,150,155));
            } else {
                ovText(dc,fS,20,88,g_shvReady?"waiting for world…":"waiting for GTA to load…",RGB(255,200,120));
            }
        }
        DeleteObject(fT); DeleteObject(fH); DeleteObject(fN); DeleteObject(fS);
        EndPaint(w,&ps);
        return 0;
    }
    if(m==WM_DESTROY){g_ov=NULL;return 0;}
    return DefWindowProcA(w,m,a,b);
}
static DWORD WINAPI overlayThread(LPVOID){logf("overlay start");HINSTANCE hi=(HINSTANCE)GetModuleHandleA(NULL);WNDCLASSEXA wc={0};wc.cbSize=sizeof(wc);wc.lpfnWndProc=wndProc;wc.hInstance=hi;wc.hbrBackground=CreateSolidBrush(OVERLAY_KEY);wc.lpszClassName=OV_CLASS;RegisterClassExA(&wc);for(int i=0;i<200&&g_running;i++){g_gta=findGtaWnd();if(g_gta)break;Sleep(100);}if(g_gta){char t[96]={0};GetWindowTextA(g_gta,t,96);logf("GTA hwnd=%p '%s'",(void*)g_gta,t);}g_ov=CreateWindowExA(WS_EX_TOPMOST|WS_EX_LAYERED|WS_EX_TRANSPARENT|WS_EX_TOOLWINDOW|WS_EX_NOACTIVATE,OV_CLASS,"GTAMP",WS_POPUP|WS_VISIBLE,0,0,720,240,NULL,NULL,hi,NULL);if(g_ov){SetLayeredWindowAttributes(g_ov,OVERLAY_KEY,255,LWA_COLORKEY|LWA_ALPHA);logf("overlay %p",(void*)g_ov);}strcpy_s(g_f.err,"Waiting for SHV ready...");MSG m;DWORD la=timeGetTime();
    while(g_running){while(PeekMessageA(&m,NULL,0,0,PM_REMOVE)){TranslateMessage(&m);DispatchMessageA(&m);}if(!g_gta||!IsWindow(g_gta))g_gta=findGtaWnd();if(g_gta&&IsWindow(g_gta)&&g_ov){RECT g;if(IsWindowVisible(g_gta)&&GetWindowRect(g_gta,&g)){bool full=g_consoleOpen||g_joinActive;
if(full)SetWindowPos(g_ov,HWND_TOPMOST,g.left,g.top,g.right-g.left,g.bottom-g.top,SWP_NOACTIVATE|SWP_SHOWWINDOW|SWP_NOOWNERZORDER);
else SetWindowPos(g_ov,HWND_TOPMOST,g.left+16,g.top+16,720,240,SWP_NOACTIVATE|SWP_SHOWWINDOW|SWP_NOOWNERZORDER);
ShowWindow(g_ov,(full||g_vis)?SW_SHOWNOACTIVATE:SW_HIDE);InvalidateRect(g_ov,NULL,FALSE);}}if(GetAsyncKeyState(VK_F9)&1){g_vis=!g_vis;logf("overlay %s",g_vis?"on":"off");Sleep(250);}if(GetAsyncKeyState(VK_F10)&1){if(g_shvReady){logf("rescan (F10)");g_f.found=false;la=timeGetTime()-2000;doScan();}Sleep(250);}if(GetAsyncKeyState(VK_F11)&1){if(shv::loaded()){logf("F11 pressed - queuing local cop spawn (shvReady=%d)",(int)g_shvReady);SpawnReq r={0};strcpy_s(r.src,"F11");strcpy_s(r.model,"s_m_y_cop_01");r.useOffset=true;r.pedType=6;queueSpawn(&r);if(!g_shvReady)snprintf(g_shvMsg,sizeof(g_shvMsg),"F11 queued - will spawn once loaded");}else{logf("F11 pressed but SHV not loaded");snprintf(g_shvMsg,sizeof(g_shvMsg),"Waiting for ScriptHookV...");}Sleep(500);}{ // v1.8.0 — F8 console: works even before ScriptHookV is ready (like FiveM)
  static bool f8w=false,escw=false,retw=false,bkw=false;
  bool f8=(GetAsyncKeyState(VK_F8)&0x8000)!=0;
  if(f8&&!f8w){
    g_consoleOpen=!g_consoleOpen;
    if(g_consoleOpen){ g_conInput[0]=0; g_conInputLen=0;
      if(g_conLogN<2){ pushConLine("GTAMP console — type 'help'",255,220,120); pushConLine("connect <ip:port> · disconnect · quit · version",170,190,220); } }
    logf("console %s",g_consoleOpen?"open":"closed");
  }
  f8w=f8;
  if(g_consoleOpen){
    bool esc=(GetAsyncKeyState(VK_ESCAPE)&0x8000)!=0; if(esc&&!escw){g_consoleOpen=false;logf("console closed (esc)");} escw=esc;
    bool ret=(GetAsyncKeyState(VK_RETURN)&0x8000)!=0; if(ret&&!retw){ if(g_conInputLen>0)runConsoleCommand(g_conInput); g_conInput[0]=0;g_conInputLen=0; } retw=ret;
    bool bk=(GetAsyncKeyState(VK_BACK)&0x8000)!=0; if(bk&&!bkw&&g_conInputLen>0)g_conInput[--g_conInputLen]=0; bkw=bk;
    static SHORT cprev[256];
    for(int vk=8; vk<256; vk++){
      if(vk==VK_F8||vk==VK_ESCAPE||vk==VK_RETURN||vk==VK_BACK||vk==VK_SHIFT||vk==VK_CONTROL||vk==VK_MENU||vk==VK_LWIN||vk==VK_RWIN) continue;
      SHORT st2=GetAsyncKeyState(vk);
      bool dn=(st2&0x8000)!=0, ws=(cprev[vk]&0x8000)!=0;
      cprev[vk]=st2;
      if(!(dn&&!ws)) continue;
      BYTE kb2[256]; GetKeyboardState(kb2);
      WCHAR wc2[4]={0};
      int n=ToUnicode((UINT)vk,MapVirtualKeyA((UINT)vk,MAPVK_VK_TO_VSC),kb2,wc2,4,0);
      if(n<=0) continue;
      for(int ci=0;ci<n;ci++){ wchar_t wch=wc2[ci]; if(wch<32||wch>126) continue;
        if(g_conInputLen>=(int)sizeof(g_conInput)-1) break;
        g_conInput[g_conInputLen++]=(char)wch; g_conInput[g_conInputLen]=0;
      }
    }
  }
}DWORD now=timeGetTime();if(g_shvReady&&!g_f.found&&now-la>1500){la=now;doScan();}Sleep(25);}if(g_ov)DestroyWindow(g_ov);UnregisterClassA(OV_CLASS,hi);return 0;
}
static void connectBridge(){
    g_sock=socket(AF_INET,SOCK_STREAM,IPPROTO_TCP);
    if(g_sock==INVALID_SOCKET){ static DWORD lt=0; DWORD n=timeGetTime(); if(n-lt>3000){lt=n; logf("bridge: socket() failed err=%u",(unsigned)WSAGetLastError());} return; }
    sockaddr_in a={0};a.sin_family=AF_INET;a.sin_port=htons(22100);inet_pton(AF_INET,"127.0.0.1",&a.sin_addr);
    if(connect(g_sock,(sockaddr*)&a,sizeof(a))==0){
        char h[256];snprintf(h,sizeof(h),"{\"t\":\"hookHello\",\"v\":\"" HOOK_VER "\",\"gta\":\"%s\"}\n",g_ver);sl(h);logf("bridge connected 127.0.0.1:22100");
    }else{
        static DWORD lt=0; DWORD n=timeGetTime(); if(n-lt>3000){lt=n; logf("bridge: connect 127.0.0.1:22100 failed err=%u (is client-bridge running?)",(unsigned)WSAGetLastError());}
        closesocket(g_sock);g_sock=INVALID_SOCKET;
    }
}
// Net-thread: parse packet and update NetPed bookkeeping ONLY.
// Any native call (spawn/delete/move) is queued for the SHV fiber.
static void handleNetLine(const char*l){int ln=(int)strlen(l);if(ln<5)return;
    // v1.8.0: FiveM-style join progress pushed from the launcher (in-game connect panel)
    if(strstr(l,"\"joinBegin\"")){
        int nl=0; const char* nv=jss(l,"server",&nl); if(nv&&nl>0){ memcpy(g_joinServer,nv,nl<63?nl:63); g_joinServer[nl<63?nl:63]=0; }
        g_joinActive=true; g_joinFailed=false; g_joinT0=timeGetTime();
        sstrcpy(g_joinStage,"Initializing multiplayer session",sizeof(g_joinStage));
        { char jl[160]; snprintf(jl,sizeof(jl),"connecting to %s", g_joinServer[0]?g_joinServer:"server"); pushConLine(jl,140,200,255); }
        return;
    }
    if(strstr(l,"\"joinStage\"")){
        if(!g_joinT0){ g_joinT0=timeGetTime(); }
        g_joinActive=true; // covers panels whose joinBegin raced the bridge link
        int nl=0; const char* nv=jss(l,"stage",&nl); if(nv&&nl>0){ memcpy(g_joinStage,nv,nl<95?nl:95); g_joinStage[nl<95?nl:95]=0; }
        if(g_joinStage[0]) pushConLine(g_joinStage,170,190,220);
        return;
    }
    if(strstr(l,"\"joinFail\"")){
        int nl=0; const char* nv=jss(l,"msg",&nl); if(nv&&nl>0){ memcpy(g_joinStage,nv,nl<95?nl:95); g_joinStage[nl<95?nl:95]=0; }
        g_joinFailed=true; g_joinActive=true;
        { char jl[180]; snprintf(jl,sizeof(jl),"FAILED: %s", g_joinStage); pushConLine(jl,255,120,120); }
        return;
    }
    if(strstr(l,"\"joinEnd\"")){
        if(g_joinActive && !g_joinFailed){ pushConLine("entered session — have fun!",120,220,140); }
        g_joinActive=false;
        return;
    }
    if(strstr(l,"\"dmg\"")){
        int d=0; jsd(l,"d",&d);
        int fl=0; const char*fv=jss(l,"from",&fl); char fn[32]="player";
        if(fv&&fl>0){ memcpy(fn,fv,fl<31?fl:31); fn[fl<31?fl:31]=0; }
        EnterCriticalSection(&g_conCs);
        g_pendingDmg += (d<0?0:(d>250?250:d));
        sstrcpy(g_pendingDmgFrom,fn,sizeof(g_pendingDmgFrom));
        LeaveCriticalSection(&g_conCs);
        logf("<- dmg from %s d=%d", fn, d);
        return;
    }
    if(strstr(l,"\"conLog\"")){
        int nl=0; const char* nv=jss(l,"msg",&nl); char m2[180]={0}; if(nv&&nl>0){ memcpy(m2,nv,nl<179?nl:179); m2[nl<179?nl:179]=0; }
        if(m2[0]) pushConLine(m2,200,200,200);
        return;
    }
    // Phase 7: incoming chat display
    if(strstr(l,"\"chat\"") && (strstr(l,"\"t\":\"chat\"")||strstr(l,"\"t\": \"chat\""))){
        int nl=0; const char* nv=jss(l,"name",&nl); char name[32]="SERVER";
        if(nv&&nl>0){ memcpy(name,nv,nl<31?nl:31); name[nl<31?nl:31]=0; }
        int ml=0; const char* mv=jss(l,"msg",&ml); char msg[CHAT_INPUT_MAX+1]={0};
        if(mv&&ml>0){ int c=ml<CHAT_INPUT_MAX?ml:CHAT_INPUT_MAX; memcpy(msg,mv,c); msg[c]=0; }
        if(msg[0]){
            char line[280]; snprintf(line,sizeof(line),"%s: %s", name, msg);
            unsigned char r=220,g=220,b=220;
            if(!strcmp(name,"SERVER")||!strcmp(name,"JOIN")||!strcmp(name,"SYSTEM")){ r=120;g=220;b=140; }
            pushChatLine(line,r,g,b);
            logf("chat: recv [%s] %s", name, msg);
        }
        return;
    }

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
        float hf=200.f; jsf(l,"health",&hf); int health=(int)hf;
        float af=0.f; jsf(l,"armour",&af); int armour=(int)af;
        float vx=0,vy=0,vz=0; jsf(l,"vx",&vx); jsf(l,"vy",&vy); jsf(l,"vz",&vz);
        int serverId=0; 
        if(id[0]=='p') serverId = atoi(id+1);
        else { float sid=0; if(jsf(l,"netId",&sid)) serverId=(int)sid; else if(jsf(l,"id",&sid) && sid>0) serverId=(int)sid; }

        EnterCriticalSection(&g_npCs);
        NetPed*np=findNetPed(id);
        bool newly=false;
        bool modelChanged=false;
        if(!np){
            np=allocNetPed();
            if(!np){LeaveCriticalSection(&g_npCs);logf("net: table full, drop id=%s",id);return;}
            sstrcpy(np->id,id,sizeof(np->id));
            np->ped=0; np->blip=0; newly=true;
            np->drawPos.x=x; np->drawPos.y=y; np->drawPos.z=z; np->drawH=h;
            logf("net: FiveM JOIN id=%s name='%s' model=%s sid=%d @ %.1f,%.1f,%.1f",id,name,model,serverId,x,y,z);
        } else {
            if(model[0] && np->model[0] && strcmp(np->model, model)!=0) modelChanged=true;
        }
        sstrcpy(np->name,name,sizeof(np->name));
        if(model[0]) sstrcpy(np->model,model,sizeof(np->model));
        np->pos.x=x; np->pos.y=y; np->pos.z=z; np->h=h;
        np->vx=vx; np->vy=vy; np->vz=vz;
        np->health=health; np->armour=armour;
        if(serverId>0) np->serverId=serverId;
        np->lastUpdate=timeGetTime();
        if(newly){ np->drawPos=np->pos; np->drawH=np->h; }
        // netPedPos = pose only. netPed / missing ped / model change = spawn once.
        bool isPosOnly = !!strstr(l, "\"netPedPos\"");
        if(modelChanged && np->ped){
            np->wantRespawn = 1;
            np->spawnQueued = 0;
        }
        // Normalize heading into 0..360 (bot was sending 500+)
        while(np->h >= 360.f) np->h -= 360.f;
        while(np->h < 0.f) np->h += 360.f;
        bool needSpawn = false;
        if(!isPosOnly || newly || !np->ped || np->wantRespawn){
            // Only one in-flight spawn command per remote player
            if(!np->ped && !np->spawnQueued && g_shvReady)
                needSpawn = true;
            else if(np->wantRespawn && !np->spawnQueued && g_shvReady)
                needSpawn = true;
            else if(!isPosOnly && newly && !np->spawnQueued && g_shvReady)
                needSpawn = true;
        }
        if(needSpawn) np->spawnQueued = 1;
        LeaveCriticalSection(&g_npCs);

        if(modelChanged){
            NpCmd d={0}; d.op=NQ_DEL; sstrcpy(d.id,id,sizeof(d.id)); queueNpCmd(&d);
            logf("net: model change id=%s -> %s", id, model);
        }
        if(needSpawn){
            NpCmd c={0}; c.op=NQ_SPAWN;
            sstrcpy(c.id,id,sizeof(c.id));
            sstrcpy(c.name,name,sizeof(c.name));
            sstrcpy(c.model,model[0]?model:"mp_m_freemode_01",sizeof(c.model));
            c.x=x; c.y=y; c.z=z; c.h=h;
            queueNpCmd(&c);
            logf("net: queue SPAWN once id=%s (posOnly=%d)", id, (int)isPosOnly);
        }
        return;
    }
    if(strstr(l,"\"spawnPed\"")||(strstr(l,"\"t\":\"spawn\"")&&!strstr(l,"\"spawned\""))){int ml=0;const char*mv=jss(l,"model",&ml);SpawnReq r={0};strcpy_s(r.src,"NET");int sl=0;const char*sv=jss(l,"src",&sl);if(sv&&sl>0&&sl<(int)sizeof(r.src)-1){memcpy(r.src,sv,sl);r.src[sl]=0;}if(mv&&ml>0&&ml<(int)sizeof(r.model)-1){memcpy(r.model,mv,ml);r.model[ml]=0;}else strcpy_s(r.model,"s_m_y_cop_01");bool off=jsb(l,"offset",false);if(strstr(l,"\"t\":\"spawn\"")&&!strstr(l,"spawnPed"))off=true;if(off){r.useOffset=true;}else{float x,y,z,h;if(!jsf(l,"x",&x)||!jsf(l,"y",&y)||!jsf(l,"z",&z)){logf("net: spawnPed missing coords, using offset");r.useOffset=true;}else{r.useOffset=false;r.x=x;r.y=y;r.z=z;r.h=jsf(l,"h",&h)?h:0.f;}}float ptf=0;r.pedType=jsf(l,"pedType",&ptf)?(int)ptf:6;queueSpawn(&r);if(!g_shvReady)logf("net: queued spawnPed src=%s model=%s (SHV not ready - queued)",r.src,r.model);else logf("net: queued spawnPed src=%s model=%s offset=%d",r.src,r.model,r.useOffset);}
}
static DWORD WINAPI netThread(LPVOID){logf("net start");WSADATA w;WSAStartup(MAKEWORD(2,2),&w);for(int i=0;i<60&&g_running;i++){connectBridge();if(g_sock!=INVALID_SOCKET)break;Sleep(500);}char rb[4096];int rbLen=0;while(g_running){if(g_sock!=INVALID_SOCKET){fd_set r;timeval tv={0,150000};FD_ZERO(&r);FD_SET(g_sock,&r);if(select(0,&r,NULL,NULL,&tv)>0){int n=recv(g_sock,rb+rbLen,(int)sizeof(rb)-1-rbLen,0);if(n<=0){logf("bridge closed");closesocket(g_sock);g_sock=INVALID_SOCKET;rbLen=0;}else{rbLen+=n;rb[rbLen]=0;char*st=rb;for(char*p=rb;p<rb+rbLen;p++){if(*p=='\n'){*p=0;char*line=st;while(*line=='\r'||*line==' ')line++;if(*line){
                        // Rate-limit spammy netPedPos logs (still process every packet)
                        if(strstr(line,"netPedPos")){
                            static DWORD lastPosLog=0; DWORD tn=timeGetTime();
                            if(tn-lastPosLog>2000){ lastPosLog=tn; logf("<- netPedPos ... (throttled)"); }
                        } else logf("<- %s",line);
                        handleNetLine(line);
                    }st=p+1;}}if(st>rb){int rem=(int)(rb+rbLen-st);memmove(rb,st,rem);rbLen=rem;}else if(rbLen>=(int)sizeof(rb)-1){logf("net: line too long");rbLen=0;}}}}else{Sleep(500);connectBridge();}}if(g_sock!=INVALID_SOCKET){closesocket(g_sock);g_sock=INVALID_SOCKET;}WSACleanup();return 0;}
static VOID WINAPI delayedShvLoad(PVOID){
    {HMODULE pe[2048];DWORD need=0;if(EnumProcessModules(GetCurrentProcess(),(HMODULE*)pe,sizeof(pe),&need)){DWORD n=need/sizeof(HMODULE);for(DWORD i=0;i<n&&i<512;i++){char nme[MAX_PATH]={0};if(GetModuleFileNameA(pe[i],nme,MAX_PATH)){const char*b=strrchr(nme,'\\');b=b?b+1:nme;if(strstr(b,"ScriptHook")||!_stricmp(b,"dinput8.dll")||!_stricmp(b,"ScriptHookV.dll"))logf("  module[%u]: %s @ %p",i,nme,(void*)pe[i]);}}}}for(int i=0;i<120&&g_running;i++){if(shv::load()){logf("ScriptHookV exports resolved OK");shv::registerScript(shvScriptMain);logf("scriptRegister called (fn=%p)",(void*)shvScriptMain);return;}if(i==0)logf("SHV not found initially (err=%u). Will retry.",(unsigned)GetLastError());Sleep(500);}logf("ScriptHookV not loadable after 60s.");
}
BOOL APIENTRY DllMain(HMODULE m,DWORD r,LPVOID){if(r==DLL_PROCESS_ATTACH){DisableThreadLibraryCalls(m);
    // v1.9.0 — FiveM parity (code/client/launcher/Main.cpp): pin the *system* D3D/DXGI DLLs early so
    // a search-path/re-hooked variant can never resolve first → classic ERR_GFX_D3D_INIT prevention.
    {
        wchar_t sysd[MAX_PATH]={0}; GetSystemDirectoryW(sysd,MAX_PATH);
        const wchar_t* pin[]={L"d3d11.dll",L"dxgi.dll",L"d3d9.dll",L"d3d10.dll",L"d3d10_1.dll",L"opengl32.dll"};
        for(int i=0;i<6;i++){
            wchar_t fp[MAX_PATH]={0};
            _snwprintf(fp,MAX_PATH-1,L"%s\\%s",sysd,pin[i]);
            if(!GetModuleHandleW(pin[i])) LoadLibraryW(fp);
        }
    }
    InitializeCriticalSection(&g_qCs);InitializeCriticalSection(&g_npCs);InitializeCriticalSection(&g_sendCs);InitializeCriticalSection(&g_conCs);g_pid=GetCurrentProcessId();char t[MAX_PATH];GetTempPathA(MAX_PATH,t);strcat_s(t,MAX_PATH,"gtamp_hook.log");fclose(fopen(t,"w"));logf("==== GTAMP hook v%s PID=%u ====",HOOK_VER,(unsigned)g_pid);HMODULE hm=GetModuleHandleA("GTA5.exe");if(!hm){logf("ERROR: GTA5.exe not found");return TRUE;}detectBuild(hm);shv::setLogger([](const char*s){logf("%s",s);});shv::setSelfHinst(m);CloseHandle(CreateThread(NULL,0,(LPTHREAD_START_ROUTINE)delayedShvLoad,NULL,0,NULL));g_ovT=CreateThread(NULL,0,overlayThread,NULL,0,NULL);g_netT=CreateThread(NULL,0,netThread,NULL,0,NULL);}else if(r==DLL_PROCESS_DETACH){g_running=false;if(g_ovT){WaitForSingleObject(g_ovT,3000);CloseHandle(g_ovT);}if(g_netT){WaitForSingleObject(g_netT,3000);CloseHandle(g_netT);}DeleteCriticalSection(&g_qCs);DeleteCriticalSection(&g_npCs);DeleteCriticalSection(&g_sendCs);DeleteCriticalSection(&g_conCs);logf("unloaded");}return TRUE;}
extern "C" __declspec(dllexport) const char* gtamp_version(){return "GTAMP Hook v" HOOK_VER;}
