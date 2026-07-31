#pragma once
#define GTAMP_PROTOCOL_VERSION 1
#define GTAMP_BRIDGE_PORT     22100
#define GTAMP_DEFAULT_PORT    22005
#define GTAMP_MAX_NAME        32
#define GTAMP_MAX_MSG         256
#define GTAMP_MAX_PLAYERS     128

enum PacketType : unsigned char {
    PKT_JOIN=1, PKT_WELCOME=2, PKT_POS=3, PKT_PLAYERS=4, PKT_CHAT=5,
    PKT_LEAVE=6, PKT_PING=7, PKT_PONG=8, PKT_KICK=9
};

#pragma pack(push,1)
struct Vec3 { float x,y,z; };
struct PositionPacket {
    unsigned char type; float x,y,z,h;
    float velx,vely,velz;
    unsigned int vehicle; unsigned char weapon,health,armour;
};
struct ChatPacket {
    unsigned char type; char nick[GTAMP_MAX_NAME]; char msg[GTAMP_MAX_MSG];
};
#pragma pack(pop)
