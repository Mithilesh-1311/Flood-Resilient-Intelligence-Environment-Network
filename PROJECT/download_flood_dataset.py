"""
download_flood_dataset.py
=========================

WHAT THIS SCRIPT DOES (in plain words)
--------------------------------------
Our ESP32 sensor nodes will one day measure four things every few seconds:
water level, "is it raining?", temperature and humidity. Before we have real
floods recorded by our own boards, we need REAL data that looks like that, so
the GRU model has something true to learn from.

This script builds that dataset from two free, public sources:

  1. UK Environment Agency (EA) Hydrology API
     - River water level every 15 minutes  (our "water_level")
     - Rain-gauge rainfall every 15 minutes (turned into our true/false "rain")

  2. Open-Meteo historical weather API
     - Air temperature and relative humidity every hour (our DHT sensor)

For each river station in the STATIONS list below it:
  a) downloads the 15-minute water level,
  b) finds the nearest rain gauge automatically and downloads its rainfall,
  c) downloads hourly temperature + humidity for that spot,
  d) lines everything up on one 15-minute clock,
  e) computes the 8 model input features we decided on,
  f) saves two CSV files per station (raw readings + ready-to-train features)
     and one combined file with all stations stacked together.

HOW TO RUN
----------
    py -m pip install pandas numpy requests
    py download_flood_dataset.py

Files appear in the folder named by OUTPUT_DIR (default: ./flood_dataset).
Re-running is safe: files already downloaded are re-used, not fetched again.

NO API KEY OR ACCOUNT IS NEEDED for either data source.
"""

from __future__ import annotations

import io
import json
import math
import sys
import time
from pathlib import Path
from typing import Dict, List, Optional

import numpy as np
import pandas as pd
import requests

# =============================================================================
# SECTION 1 - CONFIGURATION  (the only part you normally need to edit)
# =============================================================================

# ---- Which river stations to download ---------------------------------------
# Each entry is one "virtual sensor node". We picked three small, steep, fast-
# reacting catchments (the closest real-world match to a flash-flood site).
#   id        : the EA station code (a GUID). Found via the EA station search.
#   name      : friendly label used in file names.
#   role      : which of our nodes it stands in for (S1/S2/S3) - label only.
#   h_crit_m  : the water level (metres) we treat as "flood". None = let the
#               script pick the 99th percentile of the record automatically.
#               Replace with the EA flood-warning threshold if you look it up.
STATIONS: List[Dict] = [
    {   # River Cocker, Cumbria - 64 km2 catchment, hit hard by Storm Desmond (Dec 2015)
        "id": "532a2993-7275-4050-8df4-b2314bc4f8e0",
        "name": "Scalehill_RiverCocker",
        "role": "S1",
        "h_crit_m": None,
    },
    {   # River Greta at Keswick, Cumbria - flashy mountain river, repeated floods
        "id": "94de4171-c8ca-4e4c-9897-9fe4a6576582",
        "name": "LowBriery_RiverGreta",
        "role": "S2",
        "h_crit_m": None,
    },
    {   # River Valency at Boscastle, Cornwall - tiny catchment, famous 2004 flash flood
        "id": "bf11cee4-5e5e-4087-bb20-a68b0a140288",
        "name": "Boscastle_RiverValency",
        "role": "S3",
        "h_crit_m": None,
    },
]

# ---- How much history to download -------------------------------------------
# Data is fetched one calendar year at a time so no single request is huge.
START_DATE = "2015-01-01"
END_DATE = "2024-12-31"

# ---- Where to save -------------------------------------------------------------
OUTPUT_DIR = Path("flood_dataset")

# ---- Sampling clock ------------------------------------------------------------
# Everything is aligned to this step. 15 min is what the EA gauges record.
STEP = "15min"
STEP_MINUTES = 15

# ---- Rain flag ---------------------------------------------------------------
# Our MH-RD board only says wet/dry. We recreate that from the rain gauge:
# rain = True when more than RAIN_FLAG_MM fell in that 15-minute slot.
RAIN_FLAG_MM = 0.0

# ---- Feature settings ------------------------------------------------------------
LAG_STEPS = 8            # size of the "lagged level window" (8 x 15 min = 2 hours)
API_DECAY_K = 0.85       # Antecedent Precipitation Index memory: per-day decay
                         # (0.85 = yesterday's rain counts 85 %, two days ago 72 %, ...)
RAIN_GAUGE_SEARCH_KM = 25  # how far around a river station to look for a rain gauge

# ---- Network -----------------------------------------------------------------
EA_BASE = "https://environment.data.gov.uk/hydrology"
OPEN_METEO_ARCHIVE = "https://archive-api.open-meteo.com/v1/archive"
REQUEST_TIMEOUT_S = 120
MAX_RETRIES = 4


# =============================================================================
# SECTION 2 - SMALL HELPERS
# =============================================================================

def log(msg: str) -> None:
    """Print a message with a timestamp so you can see progress."""
    print(f"[{time.strftime('%H:%M:%S')}] {msg}", flush=True)


def http_get(url: str, params: Optional[dict] = None) -> requests.Response:
    """
    Download one URL. If the server is busy or the internet hiccups, wait a
    bit and try again (up to MAX_RETRIES times) instead of crashing.
    """
    last_error: Optional[Exception] = None
    for attempt in range(1, MAX_RETRIES + 1):
        try:
            r = requests.get(url, params=params, timeout=REQUEST_TIMEOUT_S)
            if r.status_code == 200:
                return r
            last_error = RuntimeError(f"HTTP {r.status_code} for {r.url}")
        except requests.RequestException as exc:
            last_error = exc
        wait = 3 * attempt
        log(f"  request failed ({last_error}); retrying in {wait}s (attempt {attempt}/{MAX_RETRIES})")
        time.sleep(wait)
    raise RuntimeError(f"Gave up on {url}: {last_error}")


def haversine_km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Straight-line distance between two GPS points, in kilometres."""
    r = 6371.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp = math.radians(lat2 - lat1)
    dl = math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(a))


def year_ranges(start: str, end: str):
    """
    Split a date span into calendar-year chunks:
      2015-01-01..2016-03-31  ->  (2015-01-01, 2016-01-01), (2016-01-01, 2016-04-01)
    The end of each chunk is exclusive, matching the EA API's 'max-date'.
    """
    s = pd.Timestamp(start)
    e = pd.Timestamp(end) + pd.Timedelta(days=1)
    cur = s
    while cur < e:
        nxt = min(pd.Timestamp(year=cur.year + 1, month=1, day=1), e)
        yield cur.strftime("%Y-%m-%d"), nxt.strftime("%Y-%m-%d")
        cur = nxt


# =============================================================================
# SECTION 3 - ENVIRONMENT AGENCY DOWNLOADS (water level + rainfall)
# =============================================================================

def ea_station_info(station_id: str) -> dict:
    """Ask the EA for a station's name, GPS position and catchment size."""
    r = http_get(f"{EA_BASE}/id/stations/{station_id}.json")
    items = r.json().get("items")
    info = items[0] if isinstance(items, list) else items
    return {
        "label": info.get("label"),
        "lat": float(info["lat"]),
        "long": float(info["long"]),
        "catchment_km2": info.get("catchmentArea"),
        "river": info.get("riverName"),
    }


def ea_nearest_rain_gauge(lat: float, long: float) -> dict:
    """
    Find the closest EA rain gauge to a river station.
    The EA API can search by GPS + radius; we then sort by distance ourselves.
    """
    r = http_get(f"{EA_BASE}/id/stations.json",
                 params={"observedProperty": "rainfall", "lat": lat, "long": long,
                         "dist": RAIN_GAUGE_SEARCH_KM})
    gauges = r.json().get("items", [])
    if not gauges:
        raise RuntimeError(f"No rain gauge within {RAIN_GAUGE_SEARCH_KM} km of ({lat}, {long})")
    for g in gauges:
        g["_dist_km"] = haversine_km(lat, long, float(g["lat"]), float(g["long"]))
    best = min(gauges, key=lambda g: g["_dist_km"])
    return {"id": best["notation"], "label": best.get("label"), "dist_km": round(best["_dist_km"], 1)}


def ea_readings(measure_id: str, cache_file: Path) -> pd.DataFrame:
    """
    Download every 15-minute reading of one EA "measure" (e.g. a station's
    level series) between START_DATE and END_DATE, one year per request.

    Returns a table with two columns: time, value.
    The raw CSV is cached on disk so a second run does not re-download.
    """
    if cache_file.exists():
        log(f"  cached: {cache_file.name}")
        return pd.read_csv(cache_file, parse_dates=["time"])

    frames = []
    for lo, hi in year_ranges(START_DATE, END_DATE):
        log(f"  fetching {measure_id[-28:]} {lo} -> {hi}")
        r = http_get(f"{EA_BASE}/id/measures/{measure_id}/readings.csv",
                     params={"mineq-date": lo, "max-date": hi})
        if not r.text.strip():
            continue
        df = pd.read_csv(io.StringIO(r.text))
        if df.empty or "dateTime" not in df.columns:
            continue
        # keep only the two columns we need; drop readings the EA marks as bad
        if "quality" in df.columns:
            df = df[~df["quality"].isin(["Missing", "Unchecked_Missing"])]
        frames.append(pd.DataFrame({
            "time": pd.to_datetime(df["dateTime"]),
            "value": pd.to_numeric(df["value"], errors="coerce"),
        }))

    if not frames:
        raise RuntimeError(f"No data returned for measure {measure_id}")
    out = pd.concat(frames).dropna().drop_duplicates("time").sort_values("time")
    out.to_csv(cache_file, index=False)
    return out


# =============================================================================
# SECTION 4 - OPEN-METEO DOWNLOAD (temperature + humidity)
# =============================================================================

def open_meteo_hourly(lat: float, long: float, cache_file: Path) -> pd.DataFrame:
    """
    Download hourly air temperature (C) and relative humidity (%) for one GPS
    point from Open-Meteo's free historical archive (ERA5 reanalysis).
    Fetched one year at a time. Returns columns: time, temperature, humidity.
    """
    if cache_file.exists():
        log(f"  cached: {cache_file.name}")
        return pd.read_csv(cache_file, parse_dates=["time"])

    frames = []
    for lo, hi in year_ranges(START_DATE, END_DATE):
        hi_inclusive = (pd.Timestamp(hi) - pd.Timedelta(days=1)).strftime("%Y-%m-%d")
        log(f"  fetching weather {lo} -> {hi_inclusive}")
        r = http_get(OPEN_METEO_ARCHIVE, params={
            "latitude": lat, "longitude": long,
            "start_date": lo, "end_date": hi_inclusive,
            "hourly": "temperature_2m,relative_humidity_2m",
            "timezone": "UTC",
        })
        h = r.json()["hourly"]
        frames.append(pd.DataFrame({
            "time": pd.to_datetime(h["time"]),
            "temperature": h["temperature_2m"],
            "humidity": h["relative_humidity_2m"],
        }))
        time.sleep(0.5)   # be polite to the free API

    out = pd.concat(frames).dropna().drop_duplicates("time").sort_values("time")
    out.to_csv(cache_file, index=False)
    return out


# =============================================================================
# SECTION 5 - LINE EVERYTHING UP ON ONE 15-MINUTE CLOCK
# =============================================================================

def build_raw_table(level: pd.DataFrame, rain: pd.DataFrame, weather: pd.DataFrame) -> pd.DataFrame:
    """
    Combine the three downloads into one table with a row every 15 minutes:

        time | level_m | rain_mm | rain (True/False) | temperature | humidity

    - level:   already 15-min; small gaps (< 1 hour) are filled by drawing a
               straight line between neighbours; bigger gaps stay empty.
    - rain:    15-min totals in mm, missing = 0 (a silent gauge is dry).
    - weather: hourly, so each hourly value is copied to the 15-min slots
               inside that hour (the air does not change much in an hour).
    """
    idx = pd.date_range(level["time"].min().floor("h"), level["time"].max().ceil("h"), freq=STEP)

    lvl = level.set_index("time")["value"].reindex(idx).interpolate(limit=3, limit_area="inside")
    rn = rain.set_index("time")["value"].reindex(idx).fillna(0.0)
    wx = weather.set_index("time").reindex(idx).ffill(limit=3)

    df = pd.DataFrame({
        "level_m": lvl,
        "rain_mm": rn,
        "temperature": wx["temperature"],
        "humidity": wx["humidity"],
    }, index=idx)
    df.index.name = "time"
    df["rain"] = df["rain_mm"] > RAIN_FLAG_MM        # the wet/dry flag our board gives
    return df


# =============================================================================
# SECTION 6 - THE 8 MODEL INPUT FEATURES
# =============================================================================

def dew_point_c(t_c: pd.Series, rh: pd.Series) -> pd.Series:
    """Dew point (C): the temperature at which the air would start to condense.
    Magnus formula - standard textbook approximation."""
    a, b = 17.625, 243.04
    rh_clipped = rh.clip(lower=1.0, upper=100.0)
    gamma = np.log(rh_clipped / 100.0) + (a * t_c) / (b + t_c)
    return (b * gamma) / (a - gamma)


def vpd_kpa(t_c: pd.Series, rh: pd.Series) -> pd.Series:
    """Vapour-pressure deficit (kPa): how 'thirsty' the air is. High VPD = dry
    air = ground dries out faster. Tetens formula."""
    es = 0.6108 * np.exp((17.27 * t_c) / (t_c + 237.3))   # saturation vapour pressure
    return es * (1.0 - rh.clip(0, 100) / 100.0)


def antecedent_precipitation_index(rain_flag: pd.Series) -> pd.Series:
    """
    API - a running 'how wet has it been lately' score.
    Each step: API = API * decay + (1 if raining now else 0).
    decay is chosen so that memory fades by API_DECAY_K per day.
    Uses the wet/dry flag (not mm) so it computes identically on our hardware.
    """
    steps_per_day = 24 * 60 / STEP_MINUTES
    k_step = API_DECAY_K ** (1.0 / steps_per_day)
    api = np.zeros(len(rain_flag))
    r = rain_flag.astype(float).to_numpy()
    for i in range(1, len(r)):
        api[i] = api[i - 1] * k_step + r[i]
    return pd.Series(api, index=rain_flag.index)


def rain_duration_min(rain_flag: pd.Series) -> pd.Series:
    """Minutes of continuous rain up to now (0 when dry)."""
    r = rain_flag.to_numpy()
    out = np.zeros(len(r))
    for i in range(1, len(r)):
        out[i] = out[i - 1] + STEP_MINUTES if r[i] else 0.0
    return pd.Series(out, index=rain_flag.index)


def add_features(df: pd.DataFrame, h_crit_m: Optional[float]) -> pd.DataFrame:
    """
    Turn the raw table into the model's input columns.
    Feature numbers match the decision doc (claude/model-feature-decision.md).
    """
    out = df.copy()
    dt_h = STEP_MINUTES / 60.0                       # step length in hours

    # 1. water level, expressed 0-100 % like our HW-038 board (per-station min-max)
    lo, hi = out["level_m"].min(), out["level_m"].max()
    out["water_level"] = (out["level_m"] - lo) / (hi - lo) * 100.0

    # 2. dh/dt - how fast the level is rising (metres per hour)
    out["dh_dt"] = out["level_m"].diff() / dt_h

    # 3. d2h/dt2 - is that rise speeding up or slowing down (metres per hour^2)
    out["d2h_dt2"] = out["dh_dt"].diff() / dt_h

    # 4. lagged level window - the last LAG_STEPS levels (lag_1 = one step ago)
    for k in range(1, LAG_STEPS + 1):
        out[f"level_lag_{k}"] = out["level_m"].shift(k)

    # 5. level normalised to the site's critical level (1.0 = at flood level)
    if h_crit_m is None:
        h_crit_m = float(out["level_m"].quantile(0.99))
    out["h_crit_m"] = h_crit_m
    out["level_norm"] = out["level_m"] / h_crit_m

    # 6. current rain duration (minutes)
    out["rain_duration_min"] = rain_duration_min(out["rain"])

    # 7. dew point and VPD - soil-wetness proxies from temperature + humidity
    out["dew_point_c"] = dew_point_c(out["temperature"], out["humidity"])
    out["vpd_kpa"] = vpd_kpa(out["temperature"], out["humidity"])

    # 8. Antecedent Precipitation Index
    out["api"] = antecedent_precipitation_index(out["rain"])

    # 0. timestamp stays as the index - used for ordering only, never as a feature
    return out


# =============================================================================
# SECTION 7 - MAIN: run every station, save the files
# =============================================================================

def process_station(st: Dict) -> pd.DataFrame:
    name = st["name"]
    log(f"=== {name} ({st['role']}) ===")
    raw_dir = OUTPUT_DIR / "raw_cache"
    raw_dir.mkdir(parents=True, exist_ok=True)

    info = ea_station_info(st["id"])
    log(f"  station: {info['label']} on {info['river']}, catchment {info['catchment_km2']} km2")

    gauge = ea_nearest_rain_gauge(info["lat"], info["long"])
    log(f"  nearest rain gauge: {gauge['label']} ({gauge['dist_km']} km away)")

    level = ea_readings(f"{st['id']}-level-i-900-m-qualified", raw_dir / f"{name}_level.csv")
    rain = ea_readings(f"{gauge['id']}-rainfall-t-900-mm-qualified", raw_dir / f"{name}_rain.csv")
    weather = open_meteo_hourly(info["lat"], info["long"], raw_dir / f"{name}_weather.csv")

    raw = build_raw_table(level, rain, weather)
    feats = add_features(raw, st["h_crit_m"])
    # Drop rows that cannot be complete: the first LAG_STEPS rows (no history
    # yet) and any slot where the river gauge itself has a gap.
    feats = feats.dropna()
    feats.insert(0, "node", st["role"])
    feats.insert(1, "station", name)

    raw.to_csv(OUTPUT_DIR / f"{name}_raw_15min.csv")
    feats.to_csv(OUTPUT_DIR / f"{name}_features.csv")

    meta = {**st, **info, "rain_gauge": gauge, "rows": int(len(feats)),
            "h_crit_m_used": float(feats["h_crit_m"].iloc[0]),
            "start": str(feats.index.min()), "end": str(feats.index.max())}
    (OUTPUT_DIR / f"{name}_meta.json").write_text(json.dumps(meta, indent=2, default=str))
    log(f"  saved {len(feats):,} rows -> {name}_features.csv")
    return feats


def main() -> None:
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    all_feats = []
    for st in STATIONS:
        try:
            all_feats.append(process_station(st))
        except Exception as exc:          # one bad station should not kill the run
            log(f"  !! {st['name']} FAILED: {exc}")
    if all_feats:
        combined = pd.concat(all_feats)
        combined.to_csv(OUTPUT_DIR / "ALL_STATIONS_features.csv")
        log(f"Done. Combined file: {len(combined):,} rows, {len(combined.columns)} columns")
    else:
        log("Nothing downloaded - check your internet connection and the station ids.")
        sys.exit(1)


if __name__ == "__main__":
    main()
