/*
 * =============================================================================
 * SIH 2026 - Environmental Monitoring & Self-Healing Mesh
 * MESH RELAY NODE FIRMWARE  (works for M1 through M7)
 * =============================================================================
 *
 * ONE reusable sketch. To build for a specific node, change ONLY the
 * NODE_ID line below, then re-flash. All GPIO wiring is identical across
 * M1-M7 (all are plain ESP32 DevKit boards), so nothing else changes.
 *
 * ROLE
 *   - Relay telemetry from source nodes (S1/S2/S3) toward the gateway,
 *     hop by hop, strictly along whichever route the gateway/Python
 *     controller has assigned - this node never decides routing itself.
 *   - Drive its two RGB LEDs to show which route slot(s) it currently
 *     occupies (colors + slot assignment come from the gateway).
 *   - Drive its blue health LED at a laptop-controlled PWM brightness.
 *   - Report its own tx/rx packet counts per link to the gateway, so the
 *     laptop can compute real, directional PDR. This node never computes
 *     or fakes a PDR value itself.
 *
 * WIRE COMPATIBILITY NOTE
 *   This firmware reuses the exact same PacketHeader/TelemetryPacket/
 *   StatsPacket/HealthCmdPacket/RouteCmdPacket layout as the gateway and
 *   source-node firmware already delivered, so all three interoperate
 *   without changes. The header's "receiver" field is this system's name
 *   for what the brief calls "next_hop" - same meaning, kept consistent
 *   with the already-shipped gateway/source code rather than introducing
 *   a duplicate field.
 *
 * REQUIRED LIBRARIES
 * ---------------------------------------------------------------------------
 *   Board core only - no external libraries needed (no sensors on this node):
 *   - "WiFi.h", "esp_now.h", "esp_wifi.h" (bundled with the ESP32 Arduino core)
 *   Boards Manager: "esp32 by Espressif Systems"
 * =============================================================================
 */

#include <WiFi.h>
#include <esp_now.h>
#include <esp_wifi.h>
#include <esp_idf_version.h>

// =============================================================================
// NODE CONFIGURATION - EDIT ONLY THIS LINE PER NODE
// =============================================================================
#define NODE_ID "M7"   // change to "M1".."M7" and re-flash for each device

// =============================================================================
// GPIO ASSIGNMENT (identical across all M1-M7 boards)
// =============================================================================
#define PIN_RGB1_R 13
#define PIN_RGB1_G 12
#define PIN_RGB1_B 14

#define PIN_RGB2_R 25
#define PIN_RGB2_G 26
#define PIN_RGB2_B 33

#define PIN_HEALTH_LED 32   // blue LED, 220-ohm series resistor

// =============================================================================
// NETWORK CONFIGURATION
// =============================================================================
#define ESPNOW_WIFI_CHANNEL 1   // MUST match the gateway's channel exactly
#define STATS_REPORT_INTERVAL_MS 2000

// Route colors, indexed by route position (R1, R2, R3, ...). Same convention
// used by the Python controller and gateway firmware - configurable/extendable.
const char *ROUTE_COLOR_BY_INDEX[6] = { "red", "green", "blue", "yellow", "magenta", "cyan" };

struct ColorDef { const char *name; uint8_t r, g, b; };
ColorDef COLOR_TABLE[] = {
  { "red",     255, 0,   0   },
  { "green",   0,   255, 0   },
  { "blue",    0,   0,   255 },
  { "yellow",  255, 255, 0   },
  { "magenta", 255, 0,   255 },
  { "cyan",    0,   255, 255 },
};
#define COLOR_TABLE_SIZE (sizeof(COLOR_TABLE) / sizeof(COLOR_TABLE[0]))

// =============================================================================
// MAC ADDRESS CONFIGURATION
// Fill in every mesh node's MAC (including this one - it's simply skipped
// when registering peers) and the ESP32-CAM gateway's MAC. A mesh node may
// need to send directly to any other mesh node (depending on the route it's
// given) or straight to the gateway (if it's a route's last hop, or when
// reporting stats), so all of these are registered as ESP-NOW peers.
// =============================================================================
const char *MESH_NODE_ORDER[7] = { "M1", "M2", "M3", "M4", "M5", "M6", "M7" };

uint8_t MESH_NODE_MAC[7][6] = {
  /* M1 */ { 0x30, 0x76, 0xF5, 0x06, 0x32, 0x18 },
  /* M2 */ { 0xD4, 0xE9, 0xF4, 0x77, 0xE8, 0x6C },
  /* M3 */ { 0x68, 0xFE, 0x71, 0x88, 0x11, 0x1C },
  /* M4 */ { 0x40, 0x91, 0x51, 0xFD, 0xEA, 0xF8 },
  /* M5 */ { 0x40, 0x91, 0x51, 0xFD, 0x52, 0x68 },
  /* M6 */ { 0x40, 0x91, 0x51, 0xFC, 0x6D, 0x24 },
  /* M7 */ { 0x40, 0x91, 0x51, 0xFC, 0x89, 0x4C },
};

uint8_t GATEWAY_MAC[6] = { 0xE0, 0x8C, 0xFE, 0x5C, 0xA1, 0x55 };  // ESP32-CAM's MAC

bool lookupMeshMac(const char *nodeId, uint8_t *macOut) {
  for (int i = 0; i < 7; i++) {
    if (strncmp(MESH_NODE_ORDER[i], nodeId, 3) == 0) {
      memcpy(macOut, MESH_NODE_MAC[i], 6);
      return true;
    }
  }
  return false;
}

// =============================================================================
// ESP-NOW PACKET STRUCTURES
// Byte-identical to the gateway and source-node firmware (same fields, same
// order, same __attribute__((packed))) so payloads decode correctly across
// all three device types.
// =============================================================================

enum PacketType : uint8_t {
  PKT_TELEMETRY  = 1,
  PKT_STATS      = 2,
  PKT_HEALTH_CMD = 3,
  PKT_ROUTE_CMD  = 4,
  PKT_PROBE      = 5,
};

struct __attribute__((packed)) PacketHeader {
  uint8_t  packet_type;
  char     source[4];
  char     sender[4];
  char     receiver[4];       // this system's "next_hop": who this specific radio hop is addressed to
  char     destination[4];
  uint16_t sequence_number;
  uint32_t timestamp;
  char     route_id[4];
};

struct __attribute__((packed)) TelemetryPacket {
  PacketHeader header;
  float   water_level;
  uint8_t rain;
  float   temperature;
  float   humidity;
};

struct __attribute__((packed)) StatsPacket {
  PacketHeader header;
  char     link_from[4];
  char     link_to[4];
  uint16_t tx_count;
  uint16_t rx_count;
};

struct __attribute__((packed)) HealthCmdPacket {
  PacketHeader header;
  uint8_t      health_percentage;
};

#define MAX_ROUTES 6
#define MAX_HOPS_PER_ROUTE 5

struct __attribute__((packed)) RouteCmdPacket {
  PacketHeader header;
  uint8_t route_count;
  uint8_t hop_count[MAX_ROUTES];
  char    hops[MAX_ROUTES][MAX_HOPS_PER_ROUTE][4];
};

// ---- Local (non-wire) configuration types -----------------------------------

// One occupied route slot on this node. Derived locally from the broadcast
// RouteCmdPacket - never received as its own message, since the broadcast
// already carries everything needed (topology for forwarding + this node's
// position in it for LED/slot assignment).
struct RouteSlot {
  bool active = false;
  char route_id[4] = "";
  char color[8] = "";
  char next_hop[4] = "";   // empty string => this is the route's last hop -> forward to gateway directly
};

#define MAX_TRACKED_LINKS 9
#define PROBE_INTERVAL_MS 3000
struct LinkCounter {
  char     peer[4] = "";
  uint16_t count = 0;
  bool     active = false;
};

// Manual forward declarations for functions taking the custom types above.
// (The Arduino IDE auto-inserts function prototypes right after the #include
// block, BEFORE these type definitions exist - without a manual prototype
// declared here, after the types, the auto-generated one breaks the build.)
void handleHealthCmd(const HealthCmdPacket &pkt);
void handleRouteCmd(const RouteCmdPacket &pkt);
void handleTelemetryForward(const TelemetryPacket &pkt);
void applyRouteSlots(RouteSlot newSlot1, RouteSlot newSlot2);
void incrementLinkCounter(LinkCounter *table, const char *peer);
void sendNeighborProbes();

// =============================================================================
// STATE
// =============================================================================

RouteSlot slot1, slot2;   // RGB LED 1 = slot1, RGB LED 2 = slot2

LinkCounter txLinks[MAX_TRACKED_LINKS];   // packets THIS node transmitted, per next-hop peer
LinkCounter rxLinks[MAX_TRACKED_LINKS];   // packets THIS node received, per sending peer

uint16_t statsSeq = 0;
uint16_t probeSeq = 0;
unsigned long lastStatsReportMs = 0;
unsigned long lastProbeMs = 0;

// Loop/duplicate suppression: last sequence number forwarded per source node.
int sourceIndex(const char *id) {
  if (strncmp(id, "S1", 2) == 0) return 0;
  if (strncmp(id, "S2", 2) == 0) return 1;
  if (strncmp(id, "S3", 2) == 0) return 2;
  return -1;
}
uint16_t lastSeqFromSource[3] = { 0, 0, 0 };
bool     haveSeqFromSource[3] = { false, false, false };

// =============================================================================
// RGB + HEALTH LED (PWM)
// =============================================================================

#define RGB_PWM_FREQ 5000
#define RGB_PWM_RES 8
#define HEALTH_LED_PWM_FREQ 5000
#define HEALTH_LED_PWM_RES 8

void setupLeds() {
  ledcAttach(PIN_RGB1_R, RGB_PWM_FREQ, RGB_PWM_RES);
  ledcAttach(PIN_RGB1_G, RGB_PWM_FREQ, RGB_PWM_RES);
  ledcAttach(PIN_RGB1_B, RGB_PWM_FREQ, RGB_PWM_RES);
  ledcAttach(PIN_RGB2_R, RGB_PWM_FREQ, RGB_PWM_RES);
  ledcAttach(PIN_RGB2_G, RGB_PWM_FREQ, RGB_PWM_RES);
  ledcAttach(PIN_RGB2_B, RGB_PWM_FREQ, RGB_PWM_RES);
  ledcAttach(PIN_HEALTH_LED, HEALTH_LED_PWM_FREQ, HEALTH_LED_PWM_RES);
}

void setHealthLedBrightness(uint8_t percent) {
  uint8_t duty = map(constrain(percent, 0, 100), 0, 100, 0, 255);
  ledcWrite(PIN_HEALTH_LED, duty);
}

void setRgbLed(int ledIndex, const char *colorName) {
  uint8_t r = 0, g = 0, b = 0;
  if (colorName != nullptr && colorName[0] != '\0') {
    for (size_t i = 0; i < COLOR_TABLE_SIZE; i++) {
      if (strcmp(COLOR_TABLE[i].name, colorName) == 0) {
        r = COLOR_TABLE[i].r;
        g = COLOR_TABLE[i].g;
        b = COLOR_TABLE[i].b;
        break;
      }
    }
  }
  if (ledIndex == 0) {
    ledcWrite(PIN_RGB1_R, r);
    ledcWrite(PIN_RGB1_G, g);
    ledcWrite(PIN_RGB1_B, b);
  } else {
    ledcWrite(PIN_RGB2_R, r);
    ledcWrite(PIN_RGB2_G, g);
    ledcWrite(PIN_RGB2_B, b);
  }
}

void clearRouteSlots() {
  slot1 = RouteSlot();
  slot2 = RouteSlot();
  setRgbLed(0, nullptr);
  setRgbLed(1, nullptr);
}

void applyRouteSlots(RouteSlot newSlot1, RouteSlot newSlot2) {
  slot1 = newSlot1;
  slot2 = newSlot2;
  setRgbLed(0, slot1.active ? slot1.color : nullptr);
  setRgbLed(1, slot2.active ? slot2.color : nullptr);
}

// =============================================================================
// LINK COUNTERS (feed PDR stats reporting)
// =============================================================================

void incrementLinkCounter(LinkCounter *table, const char *peer) {
  for (int i = 0; i < MAX_TRACKED_LINKS; i++) {
    if (table[i].active && strncmp(table[i].peer, peer, 3) == 0) {
      table[i].count++;
      return;
    }
  }
  for (int i = 0; i < MAX_TRACKED_LINKS; i++) {
    if (!table[i].active) {
      table[i].active = true;
      strncpy(table[i].peer, peer, 4);
      table[i].count = 1;
      return;
    }
  }
  Serial.printf("[%s] link counter table full, dropped stat for %s\n", NODE_ID, peer);
}

void sendStatsReport(const char *linkFrom, const char *linkTo, uint16_t tx, uint16_t rx) {
  StatsPacket pkt = {};
  pkt.header.packet_type = PKT_STATS;
  strncpy(pkt.header.source, NODE_ID, 3);
  strncpy(pkt.header.sender, NODE_ID, 3);
  strncpy(pkt.header.receiver, "GW", 3);
  strncpy(pkt.header.destination, "GW", 3);
  pkt.header.sequence_number = statsSeq++;
  pkt.header.timestamp = millis();
  strncpy(pkt.link_from, linkFrom, 4);
  strncpy(pkt.link_to, linkTo, 4);
  pkt.tx_count = tx;
  pkt.rx_count = rx;
  esp_err_t result = esp_now_send(
    GATEWAY_MAC,
    (uint8_t *)&pkt,
    sizeof(pkt)
);

Serial.printf("[M7] STATS send result = %s (%d)\n",
              esp_err_to_name(result),
              result);
}

void flushStatsReports() {
  for (int i = 0; i < MAX_TRACKED_LINKS; i++) {
    if (txLinks[i].active && txLinks[i].count > 0) {
      sendStatsReport(NODE_ID, txLinks[i].peer, txLinks[i].count, 0);
      txLinks[i].count = 0;
    }
  }
  for (int i = 0; i < MAX_TRACKED_LINKS; i++) {
    if (rxLinks[i].active && rxLinks[i].count > 0) {
      sendStatsReport(rxLinks[i].peer, NODE_ID, 0, rxLinks[i].count);
      rxLinks[i].count = 0;
    }
  }
}

// =============================================================================
// LINK-INDEPENDENT NEIGHBOR PROBING
//
// Every mesh node sends a tiny probe to every other mesh node periodically.
// Probe TX contributes to this node's TX counter for that peer; receipt of a
// probe contributes to the receiver's RX counter for the sender. The gateway
// therefore receives independent directional measurements even when a link is
// not part of an active telemetry route.
// =============================================================================

void sendNeighborProbes() {
  for (int i = 0; i < 7; i++) {
    if (strncmp(MESH_NODE_ORDER[i], NODE_ID, 3) == 0) continue;

    uint8_t targetMac[6];
    if (!lookupMeshMac(MESH_NODE_ORDER[i], targetMac)) continue;

    PacketHeader pkt = {};
    pkt.packet_type = PKT_PROBE;
    strncpy(pkt.source, NODE_ID, 3);
    strncpy(pkt.sender, NODE_ID, 3);
    strncpy(pkt.receiver, MESH_NODE_ORDER[i], 3);
    strncpy(pkt.destination, "MEAS", 4);
    pkt.sequence_number = probeSeq++;
    pkt.timestamp = millis();
    strncpy(pkt.route_id, "P", 1);

    esp_err_t result = esp_now_send(targetMac, (uint8_t *)&pkt, sizeof(pkt));

    // Count every transmission attempt. The peer's RX counter is the success
    // side of the PDR calculation.
    incrementLinkCounter(txLinks, MESH_NODE_ORDER[i]);

    Serial.printf("[%s] PROBE -> %s (%s)\n",
                  NODE_ID, MESH_NODE_ORDER[i],
                  result == ESP_OK ? "sent" : "send FAILED");
  }
}

// =============================================================================
// ROUTE COMMAND HANDLING
//
// The broadcast RouteCmdPacket carries the FULL ordered hop list per route
// (as sent by the gateway - see the ESP-NOW packet structure section of the
// chat reply). Every mesh node parses the same broadcast and independently
// derives two things from its own position within it:
//   1. Which route slot(s) it occupies, and what color to show (LED 1/LED 2)
//   2. Its forwarding next-hop for telemetry carrying that route_id
// This node never decides routing - it only reads what it was told.
// =============================================================================

void handleRouteCmd(const RouteCmdPacket &pkt) {
  RouteSlot found[2];
  int foundCount = 0;

  for (uint8_t r = 0; r < pkt.route_count && r < MAX_ROUTES; r++) {
    for (uint8_t h = 0; h < pkt.hop_count[r] && h < MAX_HOPS_PER_ROUTE; h++) {
      if (strncmp(pkt.hops[r][h], NODE_ID, 3) != 0) continue;

      if (foundCount >= 2) {
        Serial.printf("[%s] route_update REJECTED: this node appears in more than 2 routes\n", NODE_ID);
        return;  // reject the WHOLE update, keep previous (last-known-good) slots
      }

      RouteSlot s;
      s.active = true;
      snprintf(s.route_id, sizeof(s.route_id), "R%u", r + 1);
      strncpy(s.color, ROUTE_COLOR_BY_INDEX[r % COLOR_TABLE_SIZE], sizeof(s.color) - 1);
      if (h + 1 < pkt.hop_count[r]) {
        strncpy(s.next_hop, pkt.hops[r][h + 1], 4);   // next mesh hop in this route
      } else {
        s.next_hop[0] = '\0';                          // I'm the last hop -> straight to gateway
      }
      found[foundCount++] = s;
    }
  }

  if (foundCount == 0) {
    clearRouteSlots();
    Serial.printf("[%s] No active route includes this node - RGB LEDs off\n", NODE_ID);
    return;
  }

  applyRouteSlots(found[0], foundCount > 1 ? found[1] : RouteSlot());
  Serial.printf("[%s] Route slots updated: LED1=%s(%s)->%s  LED2=%s\n", NODE_ID,
                found[0].route_id, found[0].color,
                found[0].next_hop[0] ? found[0].next_hop : "GATEWAY",
                foundCount > 1 ? found[1].route_id : "OFF");
}

// =============================================================================
// HEALTH COMMAND HANDLING
// =============================================================================

void handleHealthCmd(const HealthCmdPacket &pkt) {
  if (strncmp(pkt.header.destination, NODE_ID, 3) != 0) return;  // not addressed to us
  setHealthLedBrightness(pkt.health_percentage);
  Serial.printf("[%s] Health set to %u%%\n", NODE_ID, pkt.health_percentage);
}

// =============================================================================
// TELEMETRY FORWARDING
//
// Loop/duplicate prevention: this node only re-forwards a given source's
// packet if its sequence number differs from the last one it already
// forwarded for that source. Since forwarding follows a fixed, validated
// route (never flooding), this alone prevents both infinite loops and
// duplicate relays even under retransmission or a malformed route.
// =============================================================================

void handleTelemetryForward(const TelemetryPacket &pkt) {
   Serial.printf("[%s] TELEMETRY RX: source=%s sender=%s receiver=%s route=%s seq=%u\n",
                NODE_ID,
                pkt.header.source,
                pkt.header.sender,
                pkt.header.receiver,
                pkt.header.route_id,
                pkt.header.sequence_number);
  if (strncmp(pkt.header.receiver, NODE_ID, 3) != 0) {
  Serial.printf("[%s] telemetry ignored: receiver=%s, expected=%s\n",
                NODE_ID,
                pkt.header.receiver,
                NODE_ID);
  return;
}  // this hop wasn't addressed to me

  int srcIdx = sourceIndex(pkt.header.source);
  if (srcIdx < 0) {
    Serial.printf("[%s] telemetry from unrecognized source %s ignored\n", NODE_ID, pkt.header.source);
    return;
  }
  if (haveSeqFromSource[srcIdx] && pkt.header.sequence_number == lastSeqFromSource[srcIdx]) {
    return;  // duplicate / loop - drop silently, do not re-forward
  }
  lastSeqFromSource[srcIdx] = pkt.header.sequence_number;
  haveSeqFromSource[srcIdx] = true;

  // Count this reception for PDR purposes: link sender -> me.
  incrementLinkCounter(rxLinks, pkt.header.sender);

  // Find the route slot matching this packet's route_id to get my next hop.
  const char *nextHop = nullptr;
  if (slot1.active && strncmp(slot1.route_id, pkt.header.route_id, 3) == 0) nextHop = slot1.next_hop;
  else if (slot2.active && strncmp(slot2.route_id, pkt.header.route_id, 3) == 0) nextHop = slot2.next_hop;

  if (nextHop == nullptr) {
    Serial.printf("[%s] telemetry seq=%u route=%s has no matching route slot here - dropped\n",
                  NODE_ID, pkt.header.sequence_number, pkt.header.route_id);
    return;
  }

  TelemetryPacket outPkt = pkt;
  strncpy(outPkt.header.sender, NODE_ID, 3);   // I am now the sender of this next hop

  uint8_t targetMac[6];
  bool toGateway = (nextHop[0] == '\0');
  if (toGateway) {
    memcpy(targetMac, GATEWAY_MAC, 6);
    strncpy(outPkt.header.receiver, "GW", 3);
    // Not tracked in txLinks: the gateway isn't part of the 10x10 PDR matrix.
  } else {
    if (!lookupMeshMac(nextHop, targetMac)) {
      Serial.printf("[%s] next hop %s has no known MAC - dropped\n", NODE_ID, nextHop);
      return;
    }
    strncpy(outPkt.header.receiver, nextHop, 4);
    incrementLinkCounter(txLinks, nextHop);
  }

  esp_err_t result = esp_now_send(
    targetMac,
    (uint8_t *)&outPkt,
    sizeof(outPkt)
);

bool ok = (result == ESP_OK);

Serial.printf("[M7] esp_now_send result = %s (%d)\n",
              esp_err_to_name(result),
              result);
  Serial.printf("[%s] forwarded seq=%u (%s) from %s -> %s (%s)\n",
                NODE_ID, outPkt.header.sequence_number, outPkt.header.route_id,
                pkt.header.sender, toGateway ? "GATEWAY" : nextHop, ok ? "sent" : "send FAILED");
}

// =============================================================================
// ESP-NOW DISPATCH
// =============================================================================

void handleIncomingPacket(const uint8_t *data, int len) {
  if (len < (int)sizeof(PacketHeader)) return;
  PacketHeader header;
  memcpy(&header, data, sizeof(header));

  switch (header.packet_type) {
    case PKT_TELEMETRY: {
      if (len < (int)sizeof(TelemetryPacket)) return;
      TelemetryPacket pkt;
      memcpy(&pkt, data, sizeof(pkt));
      handleTelemetryForward(pkt);
      break;
    }
    case PKT_HEALTH_CMD: {
      if (len < (int)sizeof(HealthCmdPacket)) return;
      HealthCmdPacket pkt;
      memcpy(&pkt, data, sizeof(pkt));
      handleHealthCmd(pkt);
      break;
    }
    case PKT_ROUTE_CMD: {
      if (len < (int)sizeof(RouteCmdPacket)) return;
      RouteCmdPacket pkt;
      memcpy(&pkt, data, sizeof(pkt));
      handleRouteCmd(pkt);
      break;
    }
    case PKT_PROBE: {
      if (len < (int)sizeof(PacketHeader)) return;
      PacketHeader pkt;
      memcpy(&pkt, data, sizeof(pkt));
      if (strncmp(pkt.receiver, NODE_ID, 3) != 0) return;
      incrementLinkCounter(rxLinks, pkt.sender);
      Serial.printf("[%s] PROBE RX <- %s seq=%u\n", NODE_ID, pkt.sender, pkt.sequence_number);
      break;
    }
    default:
      break;  // ignore anything else (e.g. stats reports from other nodes)
  }
}

#if ESP_IDF_VERSION >= ESP_IDF_VERSION_VAL(5, 4, 0)
void onDataSent(const wifi_tx_info_t *tx_info, esp_now_send_status_t status) {
  Serial.printf("[%s] ESP-NOW TX callback: %s\n",
                NODE_ID,
                status == ESP_NOW_SEND_SUCCESS ? "SUCCESS" : "FAIL");
}
#else
void onDataSent(const uint8_t *mac_addr, esp_now_send_status_t status) {
  Serial.printf("[%s] ESP-NOW TX callback: %s\n",
                NODE_ID,
                status == ESP_NOW_SEND_SUCCESS ? "SUCCESS" : "FAIL");
}
#endif
void onDataRecv(const esp_now_recv_info_t *info, const uint8_t *incomingData, int len) {
  handleIncomingPacket(incomingData, len);
}

// =============================================================================
// SETUP
// =============================================================================

void addPeer(uint8_t *mac) {
  if (esp_now_is_peer_exist(mac)) return;
  esp_now_peer_info_t peer = {};
  memcpy(peer.peer_addr, mac, 6);
  peer.channel = ESPNOW_WIFI_CHANNEL;
  peer.encrypt = false;
  esp_now_add_peer(&peer);
}

void setupEspNow() {
  WiFi.mode(WIFI_STA);
  esp_wifi_set_channel(ESPNOW_WIFI_CHANNEL, WIFI_SECOND_CHAN_NONE);

  if (esp_now_init() != ESP_OK) {
    Serial.println("ESP-NOW init FAILED - halting.");
    while (true) delay(1000);
  }
  esp_now_register_send_cb(onDataSent);
  esp_now_register_recv_cb(onDataRecv);

  addPeer(GATEWAY_MAC);
  for (int i = 0; i < 7; i++) {
    if (strncmp(MESH_NODE_ORDER[i], NODE_ID, 3) == 0) continue;  // skip self
    addPeer(MESH_NODE_MAC[i]);
  }
}

void setup() {
  Serial.begin(115200);
  delay(300);
  Serial.printf("\n[%s] Booting MESH RELAY node firmware...\n", NODE_ID);

  setupLeds();
  setHealthLedBrightness(100);   // default full brightness until the laptop says otherwise
  clearRouteSlots();

  setupEspNow();

  lastProbeMs = millis() - PROBE_INTERVAL_MS;
  Serial.printf("[%s] Ready. Waiting for route/health commands...\n", NODE_ID);
}

// =============================================================================
// MAIN LOOP - fully callback-driven except the periodic stats flush
// =============================================================================

void loop() {
  unsigned long now = millis();
  if (now - lastProbeMs >= PROBE_INTERVAL_MS) {
    lastProbeMs = now;
    sendNeighborProbes();
  }

  if (now - lastStatsReportMs >= STATS_REPORT_INTERVAL_MS) {
    lastStatsReportMs = now;
    flushStatsReports();
  }
}
