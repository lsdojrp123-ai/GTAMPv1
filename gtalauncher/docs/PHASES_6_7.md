# Phase 6 — Remote player lifecycle (FiveM-style)

Hook **v1.6.0**

Goal: when another player is on the server you should **see them like FiveM** — a player ped, name tag, map blip, smooth movement, gone when they leave.

## FiveM behaviour we mirror

| FiveM | GTAMP Phase 6 |
|-------|----------------|
| Server assigns player id | `netId` / hook id `p{netId}` |
| Client creates clone ped for remote players | `CREATE_PED` mission entity, no ambient AI |
| Position stream + client interpolation | `playerPos` @ ~15Hz + lerp on drawPos |
| Nametag `[id] name` above head | `drawNametags()` world→screen |
| Player blip on map | `ADD_BLIP_FOR_ENTITY` |
| Drop → entity removed | `playerLeft` → `netPedDel` → `DELETE_ENTITY` |
| Distance culling | hide past ~320m |
| Do not spawn yourself as remote | bridge `isSelfNetId` |

## Packet flow

```
Player B moves
  → UDP {t:pos} to server
  → server validates, broadcasts {t:playerPos, netId, name, model, x,y,z,h,health,...}
  → each other client bridge
  → TCP hook {t:netPedPos, id:"p2", ...}
  → hook NetPed target pos
  → SHV fiber lerps drawPos → SET_ENTITY_COORDS / HEADING
  → drawNametags each frame
```

Join:

```
spawnComplete → server playerJoin to others
  → bridge hookSpawnRemote
  → netPed → CREATE_PED + blip + nametag
```

Leave:

```
quit/timeout → playerLeft
  → netPedDel → remove blip + DELETE_ENTITY + free slot
```

## Not FiveM (yet — later phases)
- OneSync / entity lockdown / real CNetGame player slots
- GTA online-style player index (we use freemode ped clones)
- Animation / aim / weapon sync (Phase 10–11)
- Damage (Phase 8)
- Vehicles (Phase 9)
- True DX11/NUI nametag CEF (Phase 12) — we use native text

## Keys
F8 chat · F9 overlay · F10 rescan · F11 test ped
