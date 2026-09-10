/*
 * =============================================================================
 * SIH 2026 - Environmental Monitoring & Self-Healing Mesh
 * SOURCE / SENSOR NODE FIRMWARE  (works for S1, S2, and S3)
 * =============================================================================
 *
 * ONE reusable sketch. To build for a specific node, change ONLY the
 * "THIS_NODE" line in the CONFIGURATION section below, then select the
 * matching board in the Arduino IDE (S1/S2 -> an ESP8266 board, S3 -> an
 * ESP32 board). Everything else (pins, DHT type, packet handling) is
 * derived automatically from that one line.
 *
 * ROLE: this is a SOURCE node, not one of the seven mesh relay nodes.
 *   - Reads its sensors every 2 seconds and injects a telemetry packet
 *     into the mesh, addressed to whichever mesh node the Python
 *     controller has currently assigned as this node's first hop.
 *   - Listens for ROUTE_CMD broadcasts from the gateway to learn that
 *     first hop (it does NOT choose its own route - no route selection
 *     logic lives here, only "follow what I was told").
 *   - Listens for HEALTH_CMD unicasts addressed to it and drives its
 *     blue health LED brightness via PWM accordingly (health is NOT
 *     calculated locally - it is fully laptop-controlled).
 *   - Does NOT calculate or fake PDR. It only stamps every telemetry
 *     packet with a monotonic sequence number and full addressing info,
 *     which downstream nodes/the laptop use to compute real PDR.
 *
 * REQUIRED LIBRARIES (Arduino IDE Library Manager)
 * ---------------------------------------------------------------------------
 *   - "DHT sensor library" by Adafruit   (works for both DHT11 and DHT22)
 *   - "Adafruit Unified Sensor"          (dependency of the above)
 *   Board cores (Boards Manager):
 *   - "esp8266 by ESP8266 Community"     (for S1/S2)
 *   - "esp32 by Espressif Systems"       (for S3)
 * =============================================================================
 */

#include <DHT.h>

#if defined(ARDUINO_ARCH_ESP8266)
  #include <ESP8266WiFi.h>
  #include <espnow.h>
  extern "C" {
    #include <user_interface.h>   // wifi_set_channel()
  }
#elif defined(ARDUINO_ARCH_ESP32)
  #include <WiFi.h>
  #include <esp_now.h>
  #include <esp_wifi.h>
  #include <esp_idf_version.h>
#else
  #error "This sketch only supports ESP8266 (S1/S2) or ESP32 (S3) boards."
#endif

// =============================================================================
// NODE CONFIGURATION - EDIT ONLY THIS LINE PER NODE
// =============================================================================
#define NODE_S1 1
#define NODE_S2 2
#define NODE_S3 3

// >>> Set to NODE_S1, NODE_S2, or NODE_S3, then re-flash for each device <<<
#define THIS_NODE NODE_S3

// >>> Set to true if no DHT/HW-038/MH-RD are physically wired yet. Sends
// plausible fake readings instead, so you can test ESP-NOW/routing/health
// end-to-end before wiring sensors. Set to false once hardware is attached. <<<
#define USE_SIMULATED_SENSORS false

#if THIS_NODE == NODE_S1
  const char *NODE_ID = "S1";
  #if !defined(ARDUINO_ARCH_ESP8266)
    #error "S1 must be built for an ESP8266 board."
  #endif
#elif THIS_NODE == NODE_S2
  const char *NODE_ID = "S2";
  #if !defined(ARDUINO_ARCH_ESP8266)
    #error "S2 must be built for an ESP8266 board."
  #endif
#elif THIS_NODE == NODE_S3
  const char *NODE_ID = "S3";
  #if !defined(ARDUINO_ARCH_ESP32)
    #error "S3 must be built for an ESP32 board."
  #endif
#else
  #error "THIS_NODE must be set to NODE_S1, NODE_S2, or NODE_S3."
#endif

// =============================================================================
// PIN CONFIGURATION (derived automatically from platform)
// =============================================================================
#if defined(ARDUINO_ARCH_ESP8266)
  // ---- S1 / S2 : ESP8266 CH340 + DHT11 ----
  #define PIN_HEALTH_LED   D0
  #define PIN_DHT          D1
  #define PIN_WATER_ANALOG A0     // ESP8266 has exactly one analog input
  #define PIN_RAIN_DO      D6
  #define DHT_SENSOR_TYPE  DHT11
  #define WATER_ADC_MAX    1023   // 10-bit ADC
#elif defined(ARDUINO_ARCH_ESP32)
  // ---- S3 : ESP32 + DHT22 ----
  #define PIN_HEALTH_LED   4
  #define PIN_DHT          18
  #define PIN_WATER_ANALOG 34     // ADC1, input-only
  #define PIN_RAIN_AO      35     // ADC1, input-only (read for debug only - see notes)
  #define PIN_RAIN_DO      27
  #define DHT_SENSOR_TYPE  DHT22
  #define WATER_ADC_MAX    4095   // 12-bit ADC
#endif

// MH-RD raindrop sensor polarity. Most DO comparator outputs go LOW when
// rain is detected. Flip this if your specific module is the opposite -
// verify with the Serial monitor by wetting the sensor plate.
#define RAIN_DO_ACTIVE_LOW true

// Water-level calibration (raw ADC counts -> 0-100%). HW-038 output varies
// with immersion depth and water conductivity - recalibrate against your
// actual sensor/container before the demo.
#define WATER_RAW_DRY  0
#define WATER_RAW_FULL WATER_ADC_MAX

// =============================================================================
// NETWORK CONFIGURATION
// =============================================================================
#define ESPNOW_WIFI_CHANNEL 1   // MUST match the gateway's channel exactly
#define TELEMETRY_INTERVAL_MS 2000

// =============================================================================
// MESH NODE MAC ADDRESSES (M1-M7)
// A source node's telemetry always goes to a mesh node first, never straight
// to the gateway, so this table - not a gateway MAC - is what a source node
// needs. Fill in real MACs before the demo (read each mesh node's MAC over
// Serial from a one-line WiFi.macAddress() sketch, same as for the gateway).
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

// Gateway AP MAC. Source nodes send their PDR statistics directly to the gateway.
uint8_t GATEWAY_MAC[6] = { 0xE0, 0x8C, 0xFE, 0x5C, 0xA1, 0x55 };

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
// Must be byte-identical (same fields, same order, same __attribute__((packed)))
// to the structs used in the gateway firmware, since ESP8266 and ESP32 are
// different architectures/compilers and would otherwise pad structs
// differently, corrupting the payload on the wire.
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
  char     receiver[4];
  char     destination[4];
  uint16_t sequence_number;
  uint32_t timestamp;
  char     route_id[4];
};

struct __attribute__((packed)) TelemetryPacket {
  PacketHeader header;
  float   water_level;   // 0-100 (%)
  uint8_t rain;           // 0 or 1
  float   temperature;
  float   humidity;
};

// Per-link directional PDR report. Byte-identical to the mesh/gateway firmware.
struct __attribute__((packed)) StatsPacket {
  PacketHeader header;
  char     link_from[4];
  char     link_to[4];
  uint16_t tx_count;
  uint16_t rx_count;
};

struct __attribute__((packed)) HealthCmdPacket {
  PacketHeader header;    // destination = target node id
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

// Manual forward declarations for functions taking the custom structs above.
// (The Arduino IDE auto-inserts function prototypes right after the #include
// block, BEFORE these struct definitions exist - without a manual prototype
// declared here, after the structs, the auto-generated one breaks the build.)
void handleHealthCmd(const HealthCmdPacket &pkt);
void handleRouteCmd(const RouteCmdPacket &pkt);

// =============================================================================
// STATE
// =============================================================================

DHT dht(PIN_DHT, DHT_SENSOR_TYPE);

uint16_t seqNumber = 0;
bool haveRoute = false;
char currentNextHop[4] = "";
char currentRouteId[4] = "";

// Per-peer TX counters. Telemetry + neighbor probes both contribute to PDR.
#define MAX_PROBE_PEERS 7
struct SourceLinkCounter {
  char peer[4] = "";
  uint16_t count = 0;
  bool active = false;
};
SourceLinkCounter txLinks[MAX_PROBE_PEERS];
uint16_t statsSeq = 0;
uint16_t probeSeq = 0;
unsigned long lastProbeMs = 0;
#define PROBE_INTERVAL_MS 3000
unsigned long lastStatsReportMs = 0;
#define STATS_REPORT_INTERVAL_MS 2000

// =============================================================================
// HEALTH LED (PWM) - laptop-controlled brightness, 220-ohm series resistor
// =============================================================================

#if defined(ARDUINO_ARCH_ESP8266)
void setupHealthLed() {
  pinMode(PIN_HEALTH_LED, OUTPUT);
  analogWriteRange(255);   // match ESP32's 0-255 duty range for one shared formula
}
void setHealthLedBrightness(uint8_t percent) {
  uint8_t duty = map(constrain(percent, 0, 100), 0, 100, 0, 255);
  analogWrite(PIN_HEALTH_LED, duty);
}
#elif defined(ARDUINO_ARCH_ESP32)
#define HEALTH_LED_PWM_FREQ 5000
#define HEALTH_LED_PWM_RES  8   // 8-bit -> 0-255 duty
void setupHealthLed() {
  ledcAttach(PIN_HEALTH_LED, HEALTH_LED_PWM_FREQ, HEALTH_LED_PWM_RES);
}
void setHealthLedBrightness(uint8_t percent) {
  uint8_t duty = map(constrain(percent, 0, 100), 0, 100, 0, 255);
  ledcWrite(PIN_HEALTH_LED, duty);
}
#endif

// =============================================================================
// SENSOR READING
// =============================================================================

int readWaterLevelPercent() {
  int raw = analogRead(PIN_WATER_ANALOG);
  int pct = map(raw, WATER_RAW_DRY, WATER_RAW_FULL, 0, 100);
  return constrain(pct, 0, 100);
}

bool readRainDetected() {
  int level = digitalRead(PIN_RAIN_DO);
  return RAIN_DO_ACTIVE_LOW ? (level == LOW) : (level == HIGH);
}

// =============================================================================
// ESP-NOW SEND (platform abstraction)
// =============================================================================

#if defined(ARDUINO_ARCH_ESP8266)
bool sendPacket(const uint8_t *mac, const void *data, size_t len) {
  return esp_now_send((uint8_t *)mac, (uint8_t *)data, len) == 0;
}
#elif defined(ARDUINO_ARCH_ESP32)
bool sendPacket(const uint8_t *mac, const void *data, size_t len) {
  return esp_now_send(mac, (const uint8_t *)data, len) == ESP_OK;
}
#endif

// =============================================================================
// LINK-INDEPENDENT NEIGHBOR PROBING
// =============================================================================

void incrementSourceTx(const char *peer) {
  for (int i = 0; i < MAX_PROBE_PEERS; i++) {
    if (txLinks[i].active && strncmp(txLinks[i].peer, peer, 3) == 0) {
      txLinks[i].count++;
      return;
    }
  }
  for (int i = 0; i < MAX_PROBE_PEERS; i++) {
    if (!txLinks[i].active) {
      txLinks[i].active = true;
      strncpy(txLinks[i].peer, peer, 3);
      txLinks[i].peer[3] = '\0';
      txLinks[i].count = 1;
      return;
    }
  }
}

void sendNeighborProbes() {
  for (int i = 0; i < 7; i++) {
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

    bool ok = sendPacket(targetMac, &pkt, sizeof(pkt));
    incrementSourceTx(MESH_NODE_ORDER[i]);
    Serial.printf("[%s] PROBE -> %s (%s)\n", NODE_ID, MESH_NODE_ORDER[i],
                  ok ? "sent" : "send FAILED");
  }
}

// =============================================================================
// TELEMETRY
// =============================================================================

void sendTelemetry(float waterLevelPct, bool rain, float temperature, float humidity) {
  if (!haveRoute) {
    Serial.printf("[%s] No route assigned yet - telemetry held (not faking a destination)\n", NODE_ID);
    return;
  }
  uint8_t targetMac[6];
  if (!lookupMeshMac(currentNextHop, targetMac)) {
    Serial.printf("[%s] Next hop %s has no MAC in MESH_NODE_MAC - check config\n", NODE_ID, currentNextHop);
    return;
  }

  TelemetryPacket pkt = {};
  pkt.header.packet_type = PKT_TELEMETRY;
  strncpy(pkt.header.source, NODE_ID, 3);
  strncpy(pkt.header.sender, NODE_ID, 3);       // this is the first hop, sender == source
  strncpy(pkt.header.receiver, currentNextHop, 3);
  strncpy(pkt.header.destination, "GW", 3);     // logical final destination is the gateway
  pkt.header.sequence_number = seqNumber++;
  pkt.header.timestamp = millis();
  strncpy(pkt.header.route_id, currentRouteId, 3);
  pkt.water_level = waterLevelPct;
  pkt.rain = rain ? 1 : 0;
  pkt.temperature = temperature;
  pkt.humidity = humidity;

  bool ok = sendPacket(targetMac, &pkt, sizeof(pkt));
  // Telemetry is also real link traffic and contributes to the same directional PDR.
  incrementSourceTx(currentNextHop);
  Serial.printf("[%s] seq=%u -> %s (%s) : water=%.0f%% rain=%d temp=%.1fC hum=%.1f%% (%s)\n",
                NODE_ID, pkt.header.sequence_number, currentNextHop, currentRouteId,
                waterLevelPct, pkt.rain, temperature, humidity,
                ok ? "sent" : "send FAILED");
}

void sendStatsReport() {
  for (int i = 0; i < MAX_PROBE_PEERS; i++) {
    if (!txLinks[i].active || txLinks[i].count == 0) continue;

    StatsPacket pkt = {};
    pkt.header.packet_type = PKT_STATS;
    strncpy(pkt.header.source, NODE_ID, 3);
    strncpy(pkt.header.sender, NODE_ID, 3);
    strncpy(pkt.header.receiver, "GW", 3);
    strncpy(pkt.header.destination, "GW", 3);
    pkt.header.sequence_number = statsSeq++;
    pkt.header.timestamp = millis();
    strncpy(pkt.header.route_id, "ST", 2);
    strncpy(pkt.link_from, NODE_ID, 3);
    strncpy(pkt.link_to, txLinks[i].peer, 3);
    pkt.tx_count = txLinks[i].count;
    pkt.rx_count = 0;

    bool ok = sendPacket(GATEWAY_MAC, &pkt, sizeof(pkt));
    Serial.printf("[%s] STATS: %s -> %s TX=%u (%s)",
                  NODE_ID, pkt.link_from, pkt.link_to, pkt.tx_count,
                  ok ? "sent" : "send FAILED");
    if (ok) txLinks[i].count = 0;
  }
}

void readAndSendTelemetry() {
#if USE_SIMULATED_SENSORS
  // No hardware wired yet - generate plausible fake readings so the rest of
  // the pipeline (ESP-NOW forwarding, PDR, routing, gateway, laptop) can be
  // tested end-to-end. Values drift slightly each cycle so they look "live"
  // on the laptop dashboard instead of being perfectly static.
  static float simWater = 45.0, simTemp = 28.0, simHum = 70.0;
  simWater = constrain(simWater + random(-3, 4), 0, 100);
  simTemp  = simTemp + (random(-10, 11) / 10.0);
  simHum   = constrain(simHum + random(-2, 3), 0, 100);
  bool rain = random(0, 10) < 2;   // occasionally "rains" so you can see it flip

  Serial.printf("[%s] (SIMULATED sensors - no hardware attached)\n", NODE_ID);
  sendTelemetry(simWater, rain, simTemp, simHum);
  return;
#else
  float t = dht.readTemperature();
  float h = dht.readHumidity();
  if (isnan(t) || isnan(h)) {
    Serial.printf("[%s] DHT read failed this cycle, skipping\n", NODE_ID);
    return;
  }
  int waterPct = readWaterLevelPercent();
  bool rain = readRainDetected();

  #if defined(ARDUINO_ARCH_ESP32)
    // MH-RD AO is available on S3 (GPIO35) but not part of the wire packet -
    // the spec only requires rain/no-rain. Printed here for calibration only.
    int rainAnalog = analogRead(PIN_RAIN_AO);
    Serial.printf("[%s] (debug) rain analog raw = %d\n", NODE_ID, rainAnalog);
  #endif

  sendTelemetry((float)waterPct, rain, t, h);
#endif
}

// =============================================================================
// INCOMING COMMAND HANDLING (HEALTH_CMD, ROUTE_CMD)
// =============================================================================

void handleHealthCmd(const HealthCmdPacket &pkt) {
  if (strncmp(pkt.header.destination, NODE_ID, 3) != 0) return;  // not addressed to us
  setHealthLedBrightness(pkt.health_percentage);
  Serial.printf("[%s] Health set to %u%%\n", NODE_ID, pkt.health_percentage);
}

void handleRouteCmd(const RouteCmdPacket &pkt) {
  for (uint8_t r = 0; r < pkt.route_count; r++) {
    if (pkt.hop_count[r] < 2) continue;
    if (strncmp(pkt.hops[r][0], NODE_ID, 3) != 0) continue;

    strncpy(currentNextHop, pkt.hops[r][1], 4);
    // Route names ("R1", "R2", ...) aren't individually preserved per-hop on
    // the wire - by convention they match position in the broadcast route
    // table (index 0 = R1, index 1 = R2, ...), matching how the gateway
    // built this packet from the laptop's route_update message.
    snprintf(currentRouteId, sizeof(currentRouteId), "R%u", r + 1);
    haveRoute = true;
    Serial.printf("[%s] Route assigned: next hop = %s (%s)\n", NODE_ID, currentNextHop, currentRouteId);
    return;
  }

  // This source node isn't part of any currently active route.
  haveRoute = false;
  Serial.printf("[%s] No active route includes this node - telemetry will be held\n", NODE_ID);
}

void handleIncomingPacket(const uint8_t *data, int len) {
  if (len < (int)sizeof(PacketHeader)) return;
  PacketHeader header;
  memcpy(&header, data, sizeof(header));

  switch (header.packet_type) {
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
    case PKT_PROBE:
      // Source-side RX probing is not enabled; mesh nodes currently own the
      // source->mesh measurement direction used by routing.
      break;
    default:
      break;  // ignore telemetry/stats overheard from other nodes
  }
}

// =============================================================================
// ESP-NOW CALLBACKS (platform-specific signatures, shared handling logic)
// =============================================================================

#if defined(ARDUINO_ARCH_ESP8266)
void onDataSent(uint8_t *mac_addr, uint8_t status) {
  // status == 0 means success on ESP8266; nothing else to do here.
}
void onDataRecv(uint8_t *mac, uint8_t *incomingData, uint8_t len) {
  handleIncomingPacket(incomingData, len);
}
#elif defined(ARDUINO_ARCH_ESP32)
#if ESP_IDF_VERSION >= ESP_IDF_VERSION_VAL(5, 4, 0)
void onDataSent(const wifi_tx_info_t *tx_info, esp_now_send_status_t status) {
  // status == ESP_NOW_SEND_SUCCESS on success; nothing else to do here.
}
#else
void onDataSent(const uint8_t *mac_addr, esp_now_send_status_t status) {
  // status == ESP_NOW_SEND_SUCCESS on success; nothing else to do here.
}
#endif
void onDataRecv(const esp_now_recv_info_t *info, const uint8_t *incomingData, int len) {
  handleIncomingPacket(incomingData, len);
}
#endif

// =============================================================================
// SETUP
// =============================================================================

#if defined(ARDUINO_ARCH_ESP8266)
void setupEspNow() {
  WiFi.mode(WIFI_STA);
  WiFi.disconnect();
  wifi_set_channel(ESPNOW_WIFI_CHANNEL);

  if (esp_now_init() != 0) {
    Serial.println("[GATEWAY LINK] ESP-NOW init FAILED - halting.");
    while (true) delay(1000);
  }
  esp_now_set_self_role(ESP_NOW_ROLE_COMBO);
  esp_now_register_send_cb(onDataSent);
  esp_now_register_recv_cb(onDataRecv);

  for (int i = 0; i < 7; i++) {
    esp_now_add_peer(MESH_NODE_MAC[i], ESP_NOW_ROLE_COMBO, ESPNOW_WIFI_CHANNEL, NULL, 0);
  }
  esp_now_add_peer(GATEWAY_MAC, ESP_NOW_ROLE_COMBO, ESPNOW_WIFI_CHANNEL, NULL, 0);
}
#elif defined(ARDUINO_ARCH_ESP32)
void setupEspNow() {
  WiFi.mode(WIFI_STA);
  esp_wifi_set_channel(ESPNOW_WIFI_CHANNEL, WIFI_SECOND_CHAN_NONE);

  if (esp_now_init() != ESP_OK) {
    Serial.println("[GATEWAY LINK] ESP-NOW init FAILED - halting.");
    while (true) delay(1000);
  }
  esp_now_register_send_cb(onDataSent);
  esp_now_register_recv_cb(onDataRecv);

  for (int i = 0; i < 7; i++) {
    esp_now_peer_info_t peer = {};
    memcpy(peer.peer_addr, MESH_NODE_MAC[i], 6);
    peer.channel = ESPNOW_WIFI_CHANNEL;
    peer.encrypt = false;
    esp_now_add_peer(&peer);
  }

  esp_now_peer_info_t gatewayPeer = {};
  memcpy(gatewayPeer.peer_addr, GATEWAY_MAC, 6);
  gatewayPeer.channel = ESPNOW_WIFI_CHANNEL;
  gatewayPeer.encrypt = false;
  esp_now_add_peer(&gatewayPeer);
}
#endif

void setup() {
  Serial.begin(115200);
  delay(300);
  Serial.printf("\n[%s] Booting SOURCE node firmware...\n", NODE_ID);

  pinMode(PIN_RAIN_DO, INPUT);

  setupHealthLed();
  setHealthLedBrightness(100);   // default to full brightness until the laptop says otherwise

  dht.begin();
  setupEspNow();

  lastProbeMs = millis() - PROBE_INTERVAL_MS;
  Serial.printf("[%s] Ready. Waiting for route assignment from gateway...\n", NODE_ID);
}

// =============================================================================
// MAIN LOOP - non-blocking 2-second telemetry cycle
// =============================================================================

unsigned long lastReadMs = 0;

void loop() {
  unsigned long now = millis();
  if (now - lastReadMs >= TELEMETRY_INTERVAL_MS) {
    lastReadMs = now;
    readAndSendTelemetry();
  }

  if (now - lastProbeMs >= PROBE_INTERVAL_MS) {
    lastProbeMs = now;
    sendNeighborProbes();
  }

  if (now - lastStatsReportMs >= STATS_REPORT_INTERVAL_MS) {
    lastStatsReportMs = now;
    sendStatsReport();
  }
  // ESP-NOW receive (route/health commands) is fully callback-driven, so
  // this loop never blocks waiting on it.
}
