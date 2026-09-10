/*
 * =============================================================================
 * SIH 2026 - Environmental Monitoring & Self-Healing Mesh
 * ESP32-CAM GATEWAY FIRMWARE
 * =============================================================================
 *
 * ROLE: pure bridge. This device does NOT:
 *   - calculate PDR
 *   - run any AI / route-selection logic
 *   - run flood prediction
 * It only:
 *   1. Receives ESP-NOW packets from S1/S2/S3/M1-M7 (telemetry + stats)
 *   2. Forwards them to the laptop over Wi-Fi (TCP, JSON, one line per message)
 *   3. Receives health_update / route_update JSON from the laptop
 *   4. Forwards those as ESP-NOW packets to the relevant field nodes
 *
 * WIFI TOPOLOGY
 * -------------
 * The ESP32-CAM runs a Wi-Fi Access Point named "SIH-GATEWAY".
 * The laptop's Wi-Fi adapter joins that AP (like joining any home router).
 * The AP's own IP is fixed by ESP32 defaults at 192.168.4.1.
 * Because that IP is fixed and known in advance (whereas the laptop's IP is
 * only assigned once it joins), THIS DEVICE runs the TCP server, and the
 * laptop's Python controller connects OUT to it as a TCP client at
 * 192.168.4.1:9000. (If your existing Python script currently listens as a
 * server instead, flip it to a client pointed at this IP/port - see the
 * chat explanation for the one-function change needed.)
 *
 * ESP-NOW TOPOLOGY
 * -----------------
 * ESP-NOW requires every participating radio to sit on the SAME Wi-Fi
 * channel. This gateway fixes that channel via ESPNOW_WIFI_CHANNEL below.
 * Every field node's firmware (S1/S2/S3/M1-M7) must be configured to use
 * the identical channel number, since they are not joining the AP itself -
 * they only need to be radio-channel-aligned with the gateway.
 *
 * REQUIRED LIBRARIES (Arduino IDE Library Manager / ESP32 board core)
 * ---------------------------------------------------------------------------
 *   - "WiFi.h"        (bundled with ESP32 Arduino core)
 *   - "esp_now.h"      "        "        "        "
 *   - "ArduinoJson"    by Benoit Blanchon (install via Library Manager, v6.x or v7.x)
 *
 * BOARD SETTINGS (Arduino IDE)
 * ---------------------------------------------------------------------------
 *   Board: "AI Thinker ESP32-CAM"
 *   Upload requires an external FTDI/USB-serial adapter (ESP32-CAM has no
 *   onboard USB). Connect GPIO0 to GND before power-up/reset to enter
 *   flashing mode, remove the jumper and reset again to run normally.
 * =============================================================================
 */

#include <WiFi.h>
#include <esp_now.h>
#include <esp_wifi.h>
#include <ArduinoJson.h>

// =============================================================================
// CONFIGURATION
// =============================================================================

// ---- Wi-Fi Access Point (gateway <-> laptop) --------------------------------
const char *AP_SSID = "SIH-GATEWAY";
const char *AP_PASSWORD = "sih2026mesh";   // >= 8 chars; change if you like
const IPAddress AP_LOCAL_IP(192, 168, 4, 1);
const IPAddress AP_GATEWAY_IP(192, 168, 4, 1);
const IPAddress AP_SUBNET(255, 255, 255, 0);
const uint16_t TCP_PORT = 9000;

// ---- ESP-NOW radio channel ---------------------------------------------------
// ALL field nodes (S1,S2,S3,M1-M7) must be hardcoded to this same channel.
#define ESPNOW_WIFI_CHANNEL 1

// =============================================================================
// NODE INDEX / MAC ADDRESS CONFIGURATION
// Fill in each node's real MAC address before the demo. Read a node's MAC by
// flashing it with a one-line sketch that prints WiFi.macAddress() over
// Serial at boot (for ESP32) or WiFi.macAddress() on ESP8266 similarly.
// Order matches the Python controller's NODE_ORDER exactly:
//   0=S1 1=S2 2=S3 3=M1 4=M2 5=M3 6=M4 7=M5 8=M6 9=M7
// =============================================================================
const char *NODE_ORDER[10] = {
  "S1", "S2", "S3", "M1", "M2", "M3", "M4", "M5", "M6", "M7"
};

// ---------------------------------------------------------------------------
// >>> EDIT THESE 10 LINES WITH YOUR ACTUAL NODE MAC ADDRESSES <<<
// ---------------------------------------------------------------------------
uint8_t NODE_MAC[10][6] = {
  /* S1 */ { 0xE8, 0x68, 0xE7, 0x7E, 0x2F, 0x96 },
  /* S2 */ { 0x48, 0x55, 0x19, 0xEC, 0x4E, 0x60 },
  /* S3 */ { 0x68, 0xFE, 0x71, 0x14, 0x1D, 0xDC },
  /* M1 */ { 0x30, 0x76, 0xF5, 0x06, 0x32, 0x18 },
  /* M2 */ { 0xD4, 0xE9, 0xF4, 0x77, 0xE8, 0x6C },
  /* M3 */ { 0x68, 0xFE, 0x71, 0x88, 0x11, 0x1C },
  /* M4 */ { 0x40, 0x91, 0x51, 0xFD, 0xEA, 0xF8 },
  /* M5 */ { 0x40, 0x91, 0x51, 0xFD, 0x52, 0x68 },
  /* M6 */ { 0x40, 0x91, 0x51, 0xFC, 0x6D, 0x24 },
  /* M7 */ { 0x40, 0x91, 0x51, 0xFC, 0x89, 0x4C },
};
// ---------------------------------------------------------------------------

uint8_t BROADCAST_MAC[6] = { 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF };

int nodeIndexFromId(const char *id) {
  for (int i = 0; i < 10; i++) {
    if (strncmp(NODE_ORDER[i], id, 4) == 0) return i;
  }
  return -1;
}

bool isMeshNode(const char *id) {
  return id[0] == 'M';
}

// =============================================================================
// ESP-NOW MESSAGE STRUCTURE
// A common header is prepended to every payload so PDR-relevant fields
// (source, sender, receiver, destination, sequence_number, packet_type,
// timestamp, route_id) are always present, per spec.
//   source      = the node that originated the data (e.g. "S1" for telemetry)
//   sender      = the node that just transmitted THIS radio hop
//   receiver    = the node meant to receive THIS radio hop
//   destination = final destination of the message (e.g. "GW" for the
//                 gateway, or a node id for a health/route command)
// =============================================================================

enum PacketType : uint8_t {
  PKT_TELEMETRY   = 1,
  PKT_STATS       = 2,
  PKT_HEALTH_CMD  = 3,
  PKT_ROUTE_CMD   = 4,
  PKT_PROBE       = 5,
};

struct __attribute__((packed)) PacketHeader {
  uint8_t  packet_type;
  char     source[4];
  char     sender[4];
  char     receiver[4];
  char     destination[4];
  uint16_t sequence_number;
  uint32_t timestamp;
  char     route_id[4];
};

struct __attribute__((packed)) TelemetryPacket {
  PacketHeader header;
  float   water_level;
  uint8_t rain;          // 0 or 1
  float   temperature;
  float   humidity;
};

struct __attribute__((packed)) StatsPacket {
  PacketHeader header;
  char     link_from[4];   // directed link this report is about
  char     link_to[4];
  uint16_t tx_count;       // delta tx attempts since last report
  uint16_t rx_count;       // delta successfully received since last report
};

struct __attribute__((packed)) HealthCmdPacket {
  PacketHeader header;      // destination = target node id
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

// =============================================================================
// WI-FI <-> LAPTOP MESSAGE STRUCTURE (JSON, newline-delimited, over TCP)
//
// Gateway -> laptop:
//   {"type":"telemetry","node":"S1","water_level":72,"rain":true,
//    "temperature":29.4,"humidity":82,"sequence_number":118}
//   {"type":"packet_stat","from":"M1","to":"M4","tx":5,"rx":4}
//
// Laptop -> gateway:
//   {"type":"health_update","health":{"S1":100,...,"M4":25,...}}
//   {"type":"route_update","routes":{"R1":["S1","M1","M4","M7"], ...}}
// =============================================================================

WiFiServer tcpServer(TCP_PORT);
WiFiClient laptopClient;
uint16_t gatewayOutSeq = 0;

// =============================================================================
// SETUP
// =============================================================================

void onEspNowRecv(const esp_now_recv_info_t *info, const uint8_t *data, int len);
// The Arduino IDE auto-generates function prototypes and inserts them right
// after the #include block above - i.e. BEFORE the TelemetryPacket/StatsPacket
// struct definitions further down this file. Any function taking one of
// those structs as a parameter needs its own prototype declared here (after
// the structs), so the IDE detects it already exists and skips generating
// its own broken one.
void forwardTelemetry(const TelemetryPacket &pkt);
void forwardStats(const StatsPacket &pkt);

void setup() {
  Serial.begin(115200);
  delay(500);
  Serial.println("\n[GATEWAY] Booting...");

  setupWiFiAP();
  Serial.print("[GATEWAY] AP MAC = ");
    Serial.println(WiFi.softAPmacAddress());

    Serial.print("[GATEWAY] STA MAC = ");
    Serial.println(WiFi.macAddress());

  setupEspNow();

  tcpServer.begin();
  Serial.printf("[GATEWAY] TCP server listening on %s:%u\n",
                AP_LOCAL_IP.toString().c_str(), TCP_PORT);
  Serial.println("[GATEWAY] Ready.");
}

void setupWiFiAP() {
  WiFi.mode(WIFI_AP);
  WiFi.softAPConfig(AP_LOCAL_IP, AP_GATEWAY_IP, AP_SUBNET);
  WiFi.softAP(AP_SSID, AP_PASSWORD, ESPNOW_WIFI_CHANNEL);
  Serial.printf("[GATEWAY] AP \"%s\" started on channel %d, IP %s\n",
                AP_SSID, ESPNOW_WIFI_CHANNEL, WiFi.softAPIP().toString().c_str());
}

void setupEspNow() {
  if (esp_now_init() != ESP_OK) {
    Serial.println("[GATEWAY] ESP-NOW init FAILED - halting.");
    while (true) delay(1000);
  }
  esp_now_register_recv_cb(onEspNowRecv);

  // Register every field node as a peer, plus the broadcast address (used
  // for route commands, since every node needs to see the same route table).
  addPeer(BROADCAST_MAC);
  for (int i = 0; i < 10; i++) {
    addPeer(NODE_MAC[i]);
  }
}

void addPeer(uint8_t *mac) {
  if (esp_now_is_peer_exist(mac)) return;
  esp_now_peer_info_t peer = {};
  memcpy(peer.peer_addr, mac, 6);
  peer.channel = ESPNOW_WIFI_CHANNEL;
  peer.encrypt = false;
  peer.ifidx = WIFI_IF_AP;   // gateway is in AP mode
  esp_err_t result = esp_now_add_peer(&peer);
  if (result != ESP_OK) {
    Serial.printf("[GATEWAY] Failed to add peer %02X:%02X:%02X:%02X:%02X:%02X (err %d)\n",
                  mac[0], mac[1], mac[2], mac[3], mac[4], mac[5], result);
  }
}

// =============================================================================
// MAIN LOOP
// =============================================================================

void loop() {
  acceptLaptopConnection();
  pollLaptopMessages();
  // ESP-NOW receive is fully interrupt/callback-driven (onEspNowRecv), so
  // nothing to poll for that side - this loop never blocks.
  delay(5);
}

void acceptLaptopConnection() {
  if (!laptopClient || !laptopClient.connected()) {
    WiFiClient incoming = tcpServer.available();
    if (incoming) {
      laptopClient = incoming;
      Serial.println("[GATEWAY] Laptop connected.");
    }
  }
}

// =============================================================================
// LAPTOP -> GATEWAY: read newline-delimited JSON commands, forward via ESP-NOW
// =============================================================================

void pollLaptopMessages() {
  if (!laptopClient || !laptopClient.connected()) return;
  if (!laptopClient.available()) return;

  String line = laptopClient.readStringUntil('\n');
  line.trim();
  if (line.length() == 0) return;

  StaticJsonDocument<1024> doc;
  DeserializationError err = deserializeJson(doc, line);
  if (err) {
    Serial.printf("[GATEWAY] Bad JSON from laptop: %s\n", err.c_str());
    return;
  }

  const char *type = doc["type"] | "";
  if (strcmp(type, "health_update") == 0) {
    handleHealthUpdate(doc);
  } else if (strcmp(type, "route_update") == 0) {
    handleRouteUpdate(doc);
  } else {
    Serial.printf("[GATEWAY] Unknown message type from laptop: %s\n", type);
  }
}

// ---- health_update: forward one HEALTH_CMD per node, unicast --------------
void handleHealthUpdate(JsonDocument &doc) {
  JsonObject health = doc["health"];
  if (health.isNull()) return;

  for (JsonPair kv : health) {
    const char *nodeId = kv.key().c_str();
    int idx = nodeIndexFromId(nodeId);
    if (idx < 0) {
      Serial.printf("[GATEWAY] health_update: unknown node %s, skipped\n", nodeId);
      continue;
    }
    uint8_t pct = (uint8_t)constrain((int)kv.value().as<int>(), 0, 100);

    HealthCmdPacket pkt = {};
    pkt.header.packet_type = PKT_HEALTH_CMD;
    strncpy(pkt.header.source, "GW", 3);
    strncpy(pkt.header.sender, "GW", 3);
    strncpy(pkt.header.receiver, nodeId, 3);
    strncpy(pkt.header.destination, nodeId, 3);
    pkt.header.sequence_number = gatewayOutSeq++;
    pkt.header.timestamp = millis();
    pkt.health_percentage = pct;

    esp_err_t result = esp_now_send(NODE_MAC[idx], (uint8_t *)&pkt, sizeof(pkt));
    Serial.printf("[GATEWAY] health_update -> %s = %u%% (%s)\n",
                  nodeId, pct, result == ESP_OK ? "sent" : "send FAILED");
  }
}

// ---- route_update: basic validation, then broadcast the route table -------
// Basic validation mirrors the Python-side rule: no mesh node (M1-M7) may
// appear in more than 2 routes. The laptop already validated this before
// sending, but the gateway re-checks as a safety net and refuses to forward
// an invalid table rather than pushing bad state onto the mesh.
bool validateRouteCounts(JsonObject routes) {
  int counts[10] = { 0 };
  for (JsonPair kv : routes) {
    JsonArray hops = kv.value().as<JsonArray>();
    for (JsonVariant hop : hops) {
      const char *nodeId = hop.as<const char *>();
      if (isMeshNode(nodeId)) {
        int idx = nodeIndexFromId(nodeId);
        if (idx >= 0) counts[idx]++;
      }
    }
  }
  for (int i = 0; i < 10; i++) {
    if (counts[i] > 2) {
      Serial.printf("[GATEWAY] route_update REJECTED: %s appears in %d routes (max 2)\n",
                    NODE_ORDER[i], counts[i]);
      return false;
    }
  }
  return true;
}

void handleRouteUpdate(JsonDocument &doc) {
  JsonObject routes = doc["routes"];
  if (routes.isNull()) return;

  if (!validateRouteCounts(routes)) {
    return;  // do not forward an invalid route table to the mesh
  }

  RouteCmdPacket pkt = {};
  pkt.header.packet_type = PKT_ROUTE_CMD;
  strncpy(pkt.header.source, "GW", 3);
  strncpy(pkt.header.sender, "GW", 3);
  strncpy(pkt.header.receiver, "ALL", 4);
  strncpy(pkt.header.destination, "ALL", 4);
  pkt.header.sequence_number = gatewayOutSeq++;
  pkt.header.timestamp = millis();

  uint8_t routeIdx = 0;
  for (JsonPair kv : routes) {
    if (routeIdx >= MAX_ROUTES) {
      Serial.println("[GATEWAY] route_update: more routes than MAX_ROUTES, truncating");
      break;
    }
    strncpy(pkt.header.route_id, kv.key().c_str(), 3);  // last route_id wins in header; per-hop id lives in hops[][]
    JsonArray hops = kv.value().as<JsonArray>();
    uint8_t hopIdx = 0;
    for (JsonVariant hop : hops) {
      if (hopIdx >= MAX_HOPS_PER_ROUTE) break;
      strncpy(pkt.hops[routeIdx][hopIdx], hop.as<const char *>(), 3);
      hopIdx++;
    }
    pkt.hop_count[routeIdx] = hopIdx;
    routeIdx++;
  }
  pkt.route_count = routeIdx;

  esp_err_t result = esp_now_send(BROADCAST_MAC, (uint8_t *)&pkt, sizeof(pkt));
  Serial.printf("[GATEWAY] route_update broadcast (%u routes): %s\n",
                pkt.route_count, result == ESP_OK ? "sent" : "send FAILED");
}

// =============================================================================
// FIELD NODES -> GATEWAY: ESP-NOW receive callback, forward to laptop as JSON
// =============================================================================

void onEspNowRecv(const esp_now_recv_info_t *info, const uint8_t *data, int len) {
  Serial.printf("[GATEWAY] ESP-NOW RX: %d bytes\n", len);
  if (len < (int)sizeof(PacketHeader)) return;

  PacketHeader header;
  memcpy(&header, data, sizeof(PacketHeader));

  switch (header.packet_type) {
    case PKT_TELEMETRY: {
      Serial.println("[GATEWAY] Received TELEMETRY");
      if (len < (int)sizeof(TelemetryPacket)) return;

      TelemetryPacket pkt;
      memcpy(&pkt, data, sizeof(pkt));
      forwardTelemetry(pkt);
      break;
    }
    case PKT_STATS: {
      Serial.println("[GATEWAY] Received STATS");
      if (len < (int)sizeof(StatsPacket)) return;
      StatsPacket pkt;
      memcpy(&pkt, data, sizeof(pkt));
      forwardStats(pkt);
      break;
    }
    default:
      Serial.printf("[GATEWAY] Ignoring unexpected packet_type %u from field node\n",
                    header.packet_type);
      break;
  }
}

void sendJsonLine(JsonDocument &doc) {
  if (!laptopClient || !laptopClient.connected()) return;  // nothing to do until laptop connects
  String out;
  serializeJson(doc, out);
  laptopClient.println(out);
}

void forwardTelemetry(const TelemetryPacket &pkt) {
  StaticJsonDocument<256> doc;
  doc["type"] = "telemetry";
  doc["node"] = pkt.header.source;
  doc["water_level"] = pkt.water_level;
  doc["rain"] = (bool)pkt.rain;
  doc["temperature"] = pkt.temperature;
  doc["humidity"] = pkt.humidity;
  doc["sequence_number"] = pkt.header.sequence_number;
  sendJsonLine(doc);
}

void forwardStats(const StatsPacket &pkt) {
  StaticJsonDocument<256> doc;
  doc["type"] = "packet_stat";
  doc["from"] = pkt.link_from;
  doc["to"] = pkt.link_to;
  doc["tx"] = pkt.tx_count;
  doc["rx"] = pkt.rx_count;
  sendJsonLine(doc);
}
