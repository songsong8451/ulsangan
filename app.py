import json
import logging
import math
import os
import re
import time
import xml.etree.ElementTree as ET
from concurrent.futures import ThreadPoolExecutor, as_completed
from copy import deepcopy
from datetime import datetime, timedelta
from functools import lru_cache
from threading import Lock
from urllib.parse import quote
from zoneinfo import ZoneInfo

from cachetools import TTLCache
import requests
from dotenv import load_dotenv
from flask import Flask, Response, jsonify, request, send_from_directory
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry

load_dotenv()

app = Flask(__name__, static_folder=None)
logging.getLogger("werkzeug").disabled = True
PARKS_URL = "https://api.data.go.kr/openapi/tn_pubr_public_cty_park_info_api"
ESHARE_URL = "https://www.eshare.go.kr/eshare-openapi/rsrc/list/010500/{}"
NOMINATIM_URL = "https://nominatim.openstreetmap.org"
KMA_URL = "https://apis.data.go.kr/1360000/VilageFcstInfoService_2.0"
AIR_KOREA_URL = "https://apis.data.go.kr/B552584/ArpltnInforInqireSvc"
PAGE_SIZE = 100
MAX_PAGES = {"parks": 20, "eshare": 5}
WEATHER_CACHE_TTL_SECONDS = 300
WEATHER_STALE_TTL_SECONDS = 1800
WEATHER_CACHE = TTLCache(maxsize=100, ttl=WEATHER_CACHE_TTL_SECONDS)
WEATHER_LAST_GOOD = TTLCache(maxsize=100, ttl=WEATHER_STALE_TTL_SECONDS)
WEATHER_CACHE_LOCK = Lock()


def create_retry_session():
    retries = Retry(
        total=2,
        connect=2,
        read=1,
        status=2,
        backoff_factor=0.5,
        status_forcelist=[500, 502, 503, 504],
        allowed_methods=frozenset({"GET"}),
    )
    session = requests.Session()
    adapter = HTTPAdapter(max_retries=retries)
    session.mount("https://", adapter)
    session.mount("http://", adapter)
    return session


NAME_KEYS = {
    "name",
    "parkname",
    "parknm",
    "rsrcnm",
    "자원명",
    "공원명",
    "시설명",
    "공유자원명",
}
ADDRESS_KEYS = {
    "address",
    "addr",
    "lnmaddr",
    "lnmadr",
    "rdnmadr",
    "rdnmaddr",
    "lnmaddr",
    "소재지주소",
    "소재지도로명주소",
    "소재지지번주소",
    "주소",
    "위치",
}
LAT_KEYS = {"lat", "latitude", "gpslat", "위도", "위도값", "위치위도"}
LON_KEYS = {"lon", "lng", "lot", "longitude", "gpslong", "경도", "경도값", "위치경도"}
DETAIL_KEYS = {
    "fcltyinfo",
    "facilityinfo",
    "etcfclty",
    "mvmfclty",
    "parkse",
    "시설정보",
    "운동기구",
    "부대시설",
    "상세정보",
}

PROVINCE_CODES = {
    "서울": "11",
    "부산": "26",
    "대구": "27",
    "인천": "28",
    "광주": "29",
    "대전": "30",
    "울산": "31",
    "세종": "36",
    "경기": "41",
    "강원": "42",
    "충북": "43",
    "충청북": "43",
    "충남": "44",
    "충청남": "44",
    "전북": "45",
    "전라북": "45",
    "전남": "46",
    "전라남": "46",
    "경북": "47",
    "경상북": "47",
    "경남": "48",
    "경상남": "48",
    "제주": "50",
}


def normalized_key(value):
    return re.sub(r"[^0-9a-z가-힣]", "", str(value).lower())


def get_weather_cache(cache_key, max_age=None):
    with WEATHER_CACHE_LOCK:
        cached = WEATHER_CACHE.get(cache_key)
        if cached is None and max_age is None:
            cached = WEATHER_LAST_GOOD.get(cache_key)
        if not cached:
            return None
        age = time.monotonic() - cached["saved_at"]
        if max_age is not None and age > max_age:
            return None
        return deepcopy(cached["payload"]), age


def set_weather_cache(cache_key, payload):
    with WEATHER_CACHE_LOCK:
        entry = {"saved_at": time.monotonic(), "payload": deepcopy(payload)}
        WEATHER_CACHE[cache_key] = entry
        WEATHER_LAST_GOOD[cache_key] = deepcopy(entry)


def xml_to_value(element):
    children = list(element)
    if not children:
        return element.text.strip() if element.text else ""
    result = {}
    for child in children:
        value = xml_to_value(child)
        if child.tag in result:
            if not isinstance(result[child.tag], list):
                result[child.tag] = [result[child.tag]]
            result[child.tag].append(value)
        else:
            result[child.tag] = value
    return result


def parse_payload(response, response_format):
    if "xml" in response.headers.get("Content-Type", "").lower():
        return xml_to_value(ET.fromstring(response.content))
    try:
        return response.json()
    except (ValueError, json.JSONDecodeError):
        return xml_to_value(ET.fromstring(response.content))


def find_records(value):
    if isinstance(value, list):
        for entry in value:
            yield from find_records(entry)
    elif isinstance(value, dict):
        keys = {normalized_key(key) for key in value}
        if keys.intersection(NAME_KEYS) and (
            keys.intersection(ADDRESS_KEYS) or keys.intersection(LAT_KEYS)
        ):
            yield value
        else:
            for entry in value.values():
                yield from find_records(entry)


def find_total(value):
    if isinstance(value, dict):
        for key, item in value.items():
            if normalized_key(key) in {"totalcount", "totcnt", "전체건수", "총건수"}:
                try:
                    return int(item)
                except (TypeError, ValueError):
                    pass
        for item in value.values():
            result = find_total(item)
            if result is not None:
                return result
    elif isinstance(value, list):
        for item in value:
            result = find_total(item)
            if result is not None:
                return result
    return None


def value_for(record, aliases):
    for key, value in record.items():
        if normalized_key(key) in aliases and value not in (None, ""):
            return value
    return ""


def numeric(value):
    try:
        number = float(str(value).replace(",", "").strip())
        return number if math.isfinite(number) else None
    except (TypeError, ValueError):
        return None


def normalize_record(record, source):
    name = str(value_for(record, NAME_KEYS)).strip()
    address = str(value_for(record, ADDRESS_KEYS)).strip()
    detail = " · ".join(
        str(value).strip()
        for key, value in record.items()
        if normalized_key(key) in DETAIL_KEYS and value not in (None, "")
    )
    lat = numeric(value_for(record, LAT_KEYS))
    lon = numeric(value_for(record, LON_KEYS))
    if not name or not address or lat is None or lon is None:
        return None
    if not (-90 <= lat <= 90 and -180 <= lon <= 180):
        return None
    result = {
        "name": name,
        "address": address,
        "lat": lat,
        "lon": lon,
        "source": source,
    }
    if detail:
        result["detail"] = detail
    for key, value in record.items():
        if normalized_key(key) in {
            "insturladdr",
            "reservationurl",
            "예약url",
            "홈페이지",
        }:
            url = str(value).strip()
            if url.startswith(("https://", "http://")):
                result["url"] = url
            break
    return result


def region_code(address_details):
    text = " ".join(str(value) for value in address_details.values())
    for prefix, code in PROVINCE_CODES.items():
        if prefix in text:
            return code
    return None


def request_params(response_format, page):
    return {"pageNo": page, "numOfRows": PAGE_SIZE, "type": response_format}


@lru_cache(maxsize=20)
def load_provider_records(provider, response_format, province):
    if provider == "parks":
        key = os.environ.get("DATA_GO_KR_SERVICE_KEY", "").strip()
        if not key:
            raise RuntimeError("공원 API 인증키가 서버에 설정되지 않았습니다.")
        url = PARKS_URL
        base_params = {"serviceKey": key}
    else:
        key = os.environ.get("ESHARE_API_KEY", "").strip()
        if not key:
            raise RuntimeError("공유누리 API 인증키가 서버에 설정되지 않았습니다.")
        url = ESHARE_URL.format(quote(key, safe=""))
        base_params = {"ctpvCd": province} if province else {}
    headers = {
        "Accept": "application/json" if response_format == "json" else "application/xml"
    }

    def fetch_page(page):
        params = {**request_params(response_format, page), **base_params}
        if provider == "eshare":
            params.pop("type", None)
        try:
            response = create_retry_session().get(
                url, params=params, headers=headers, timeout=3
            )
            response.raise_for_status()
            payload = parse_payload(response, response_format)
        except (requests.RequestException, ET.ParseError, ValueError) as error:
            raise RuntimeError("외부 데이터 서비스에 연결하지 못했습니다.") from error
        status = payload.get("header", payload) if isinstance(payload, dict) else {}
        result_code = (
            str(status.get("resultCode", "")).upper()
            if isinstance(status, dict)
            else ""
        )
        if result_code and result_code not in {
            "00",
            "200",
            "OK",
            "SUCCESS",
            "NORMAL SERVICE.",
        }:
            raise RuntimeError("외부 데이터 서비스가 요청을 승인하지 않았습니다.")
        return payload

    try:
        first_page = fetch_page(1)
    except RuntimeError:
        raise
    records = list(find_records(first_page))
    total = find_total(first_page)
    page_count = min(
        MAX_PAGES[provider],
        max(1, math.ceil(total / PAGE_SIZE)) if total else MAX_PAGES[provider],
    )
    if page_count > 1:
        with ThreadPoolExecutor(max_workers=min(20, page_count - 1)) as executor:
            futures = [
                executor.submit(fetch_page, page) for page in range(2, page_count + 1)
            ]
            for future in as_completed(futures):
                try:
                    records.extend(find_records(future.result()))
                except RuntimeError:
                    continue
    normalized = []
    seen = set()
    source_name = "공원 정보" if provider == "parks" else "공유누리 체육시설"
    for record in records:
        item = normalize_record(record, source_name)
        if item:
            identity = (item["name"], item["address"])
            if identity not in seen:
                item["id"] = f"{provider}-{len(normalized)}"
                normalized.append(item)
                seen.add(identity)
    return normalized, total


def distance_km(lat1, lon1, lat2, lon2):
    radius = 6371.0088
    phi1, phi2 = math.radians(lat1), math.radians(lat2)
    delta_phi = math.radians(lat2 - lat1)
    delta_lambda = math.radians(lon2 - lon1)
    haversine = (
        math.sin(delta_phi / 2) ** 2
        + math.cos(phi1) * math.cos(phi2) * math.sin(delta_lambda / 2) ** 2
    )
    return radius * 2 * math.atan2(math.sqrt(haversine), math.sqrt(1 - haversine))


def geocode_address(address):
    try:
        response = create_retry_session().get(
            f"{NOMINATIM_URL}/search",
            params={
                "q": address,
                "format": "jsonv2",
                "addressdetails": 1,
                "limit": 1,
                "countrycodes": "kr",
            },
            headers={"User-Agent": "ShiftFitNearby/1.0 (public exercise finder)"},
            timeout=3,
        )
        response.raise_for_status()
        results = response.json()
    except (requests.RequestException, ValueError) as error:
        raise RuntimeError(
            "주소를 좌표로 바꾸는 서비스에 연결하지 못했습니다."
        ) from error
    if not results:
        raise ValueError("주소를 찾지 못했어요. 시·구·동을 포함해 다시 입력해 주세요.")
    result = results[0]
    return (
        float(result["lat"]),
        float(result["lon"]),
        result.get("display_name", address),
        region_code(result.get("address", {})),
    )


def reverse_geocode(lat, lon):
    try:
        response = create_retry_session().get(
            f"{NOMINATIM_URL}/reverse",
            params={
                "lat": lat,
                "lon": lon,
                "format": "jsonv2",
                "zoom": 10,
                "addressdetails": 1,
            },
            headers={"User-Agent": "ShiftFitNearby/1.0 (public exercise finder)"},
            timeout=3,
        )
        response.raise_for_status()
        result = response.json()
        address = result.get("address", {})
        label_parts = (
            address.get("borough")
            or address.get("city_district")
            or address.get("suburb")
            or address.get("county"),
            address.get("city") or address.get("town") or address.get("village"),
            address.get("state"),
        )
        label = ", ".join(dict.fromkeys(value for value in label_parts if value))
        return label or "현재 위치", region_code(address)
    except (requests.RequestException, ValueError):
        return "현재 위치", None


def kma_grid(lat, lon):
    earth_radius = 6371.00877
    grid_size = 5.0
    standard_lat_1, standard_lat_2 = 30.0, 60.0
    origin_lon, origin_lat = 126.0, 38.0
    origin_x, origin_y = 43, 136
    radians = math.pi / 180.0
    earth_radius /= grid_size
    sn = math.log(
        math.cos(standard_lat_1 * radians) / math.cos(standard_lat_2 * radians)
    ) / math.log(
        math.tan(math.pi * 0.25 + standard_lat_2 * radians * 0.5)
        / math.tan(math.pi * 0.25 + standard_lat_1 * radians * 0.5)
    )
    sf = math.tan(math.pi * 0.25 + standard_lat_1 * radians * 0.5) ** sn
    sf *= math.cos(standard_lat_1 * radians) / sn
    ro = earth_radius * sf / math.tan(math.pi * 0.25 + origin_lat * radians * 0.5) ** sn
    ra = earth_radius * sf / math.tan(math.pi * 0.25 + lat * radians * 0.5) ** sn
    theta = lon * radians - origin_lon * radians
    if theta > math.pi:
        theta -= 2.0 * math.pi
    theta *= sn
    nx = math.floor(ra * math.sin(theta) + origin_x + 0.5)
    ny = math.floor(ro - ra * math.cos(theta) + origin_y + 0.5)
    return nx, ny


def kma_items(operation, params):
    key = os.environ.get("DATA_GO_KR_WEATHER_SERVICE_KEY", "").strip()
    if not key:
        raise RuntimeError("기상청 API 인증키가 설정되지 않았습니다.")
    query = {
        **params,
        "serviceKey": key,
        "dataType": "JSON",
        "pageNo": 1,
    }
    try:
        response = create_retry_session().get(
            f"{KMA_URL}/{operation}",
            params=query,
            headers={"Accept": "application/json"},
            timeout=3,
        )
        response.raise_for_status()
        payload = response.json()
    except (requests.RequestException, ValueError) as error:
        raise RuntimeError("기상청 데이터 서비스에 연결하지 못했습니다.") from error
    result = payload.get("response", {}) if isinstance(payload, dict) else {}
    header = result.get("header", {}) if isinstance(result, dict) else {}
    if str(header.get("resultCode", "00")) != "00":
        raise RuntimeError("기상청에서 날씨 자료를 반환하지 않았습니다.")
    body = result.get("body", {})
    items = body.get("items", {}).get("item", []) if isinstance(body, dict) else []
    return items if isinstance(items, list) else [items] if items else []


def latest_village_base(now):
    cutoff = now - timedelta(minutes=10)
    candidates = []
    for day_delta in (-1, 0):
        date = (cutoff + timedelta(days=day_delta)).date()
        for hour in (2, 5, 8, 11, 14, 17, 20, 23):
            candidate = datetime(
                date.year, date.month, date.day, hour, tzinfo=now.tzinfo
            )
            if candidate <= cutoff:
                candidates.append(candidate)
    return max(candidates)


def kma_condition(precipitation_type, sky):
    precip_labels = {
        "1": "비",
        "2": "비와 눈",
        "3": "눈",
        "4": "소나기",
        "5": "빗방울",
        "6": "빗방울과 눈날림",
        "7": "눈날림",
    }
    if str(precipitation_type) in precip_labels:
        return precip_labels[str(precipitation_type)]
    return {"1": "맑음", "3": "구름 많음", "4": "흐림"}.get(
        str(sky), "날씨 정보 확인 중"
    )


def air_sido_name(location):
    options = (
        ("서울", "서울"),
        ("부산", "부산"),
        ("대구", "대구"),
        ("인천", "인천"),
        ("광주", "광주"),
        ("대전", "대전"),
        ("울산", "울산"),
        ("세종", "세종"),
        ("경기", "경기"),
        ("강원", "강원"),
        ("충청북", "충북"),
        ("충북", "충북"),
        ("충청남", "충남"),
        ("충남", "충남"),
        ("전라북", "전북"),
        ("전북", "전북"),
        ("전라남", "전남"),
        ("전남", "전남"),
        ("경상북", "경북"),
        ("경북", "경북"),
        ("경상남", "경남"),
        ("경남", "경남"),
        ("제주", "제주"),
    )
    for token, sido in options:
        if token in location:
            return sido
    return "전국"


def air_quality_for_location(location):
    key = os.environ.get("DATA_GO_KR_AIR_SERVICE_KEY", "").strip()
    if not key:
        raise RuntimeError("에어코리아 API 인증키가 설정되지 않았습니다.")
    params = {
        "serviceKey": key,
        "returnType": "json",
        "numOfRows": 100,
        "pageNo": 1,
        "sidoName": air_sido_name(location),
        "ver": "1.0",
    }
    try:
        response = create_retry_session().get(
            f"{AIR_KOREA_URL}/getCtprvnRltmMesureDnsty",
            params=params,
            headers={"Accept": "application/json"},
            timeout=3,
        )
        response.raise_for_status()
        payload = response.json()
    except (requests.RequestException, ValueError) as error:
        raise RuntimeError("에어코리아 대기질 자료에 연결하지 못했습니다.") from error
    result = payload.get("response", {}) if isinstance(payload, dict) else {}
    header = result.get("header", {}) if isinstance(result, dict) else {}
    if str(header.get("resultCode", "00")) != "00":
        raise RuntimeError("에어코리아에서 측정 자료를 반환하지 않았습니다.")
    body = result.get("body", {})
    collection = body.get("items", {}) if isinstance(body, dict) else {}
    items = collection.get("item", []) if isinstance(collection, dict) else collection
    if isinstance(items, dict):
        items = [items]
    if not items:
        raise RuntimeError("현재 지역에 대기질 측정 자료가 없습니다.")

    location_terms = [
        term.strip() for term in location.split(",") if len(term.strip()) >= 2
    ]

    def match_score(item):
        station = str(item.get("stationName", ""))
        if not station:
            return 0
        return max(
            (
                len(station)
                for term in location_terms
                if station in term or term in station
            ),
            default=0,
        )

    item = max(items, key=match_score)

    def grade_from(code, value, ranges):
        if str(code) in {"1", "2", "3", "4"}:
            return {"1": "좋음", "2": "보통", "3": "나쁨", "4": "매우 나쁨"}[str(code)]
        reading = numeric(value)
        if reading is None:
            return "자료 없음"
        return (
            next(label for limit, label in ranges if reading <= limit)
            if reading <= ranges[-1][0]
            else "매우 나쁨"
        )

    return {
        "station_name": item.get("stationName", "측정소 정보 없음"),
        "sido": air_sido_name(location),
        "data_time": item.get("dataTime", ""),
        "pm10": {
            "value": item.get("pm10Value", "-"),
            "grade": grade_from(
                item.get("pm10Grade1h", item.get("pm10Grade")),
                item.get("pm10Value"),
                ((30, "좋음"), (80, "보통"), (150, "나쁨")),
            ),
        },
        "pm25": {
            "value": item.get("pm25Value", "-"),
            "grade": grade_from(
                item.get("pm25Grade1h", item.get("pm25Grade")),
                item.get("pm25Value"),
                ((15, "좋음"), (35, "보통"), (75, "나쁨")),
            ),
        },
        "overall": {
            "value": item.get("khaiValue", "-"),
            "grade": grade_from(
                item.get("khaiGrade"),
                item.get("khaiValue"),
                ((50, "좋음"), (100, "보통"), (250, "나쁨")),
            ),
        },
    }


@app.route("/api/weather", methods=["GET", "POST"])
def weather():
    params = request.get_json(silent=True) if request.method == "POST" else request.args
    params = params or request.args
    address = str(params.get("address", "")).strip()[:200]
    lat, lon = numeric(params.get("lat")), numeric(params.get("lon"))
    if (lat is None) != (lon is None):
        return jsonify({"error": "위치 좌표를 확인할 수 없습니다."}), 400
    if lat is not None and lon is not None:
        if not (-90 <= lat <= 90 and -180 <= lon <= 180):
            return jsonify({"error": "위치 좌표가 올바르지 않습니다."}), 400
        location_label, _ = reverse_geocode(lat, lon)
    elif address:
        try:
            lat, lon, location_label, _ = geocode_address(address)
        except ValueError as error:
            return jsonify({"error": str(error)}), 400
        except RuntimeError:
            return jsonify(
                {"error": "주소 검색에 실패했어요. 잠시 후 다시 시도해 주세요."}
            ), 502
    else:
        return jsonify({"error": "주소를 입력하거나 현재 위치를 사용해 주세요."}), 400

    now = datetime.now(ZoneInfo("Asia/Seoul"))
    nx, ny = kma_grid(lat, lon)
    observation_time = (now - timedelta(minutes=40)).replace(
        minute=0, second=0, microsecond=0
    )
    village_base = latest_village_base(now)
    common = {"numOfRows": 1000, "nx": nx, "ny": ny}
    cache_key = (nx, ny, location_label)
    fresh_cache = get_weather_cache(cache_key, WEATHER_CACHE_TTL_SECONDS)
    if fresh_cache:
        payload, _ = fresh_cache
        payload["cache_status"] = "fresh-cache"
        return jsonify(payload)
    previous_cache = get_weather_cache(cache_key)

    def use_previous_weather():
        if not previous_cache:
            return None
        payload, age = previous_cache
        payload["stale"] = True
        payload["cache_status"] = "stale-cache"
        payload["cache_age_seconds"] = round(age)
        payload["notice"] = (
            "현재 기상청 서버 응답이 지연되어 최근 조회값을 표시하고 있어요. 실외 활동 전에는 다시 확인해 주세요."
        )
        return jsonify(payload)

    forecast_failed = False
    try:
        with ThreadPoolExecutor(max_workers=3) as executor:
            observation_future = executor.submit(
                kma_items,
                "getUltraSrtNcst",
                {
                    **common,
                    "base_date": observation_time.strftime("%Y%m%d"),
                    "base_time": observation_time.strftime("%H00"),
                },
            )
            forecast_future = executor.submit(
                kma_items,
                "getVilageFcst",
                {
                    **common,
                    "base_date": village_base.strftime("%Y%m%d"),
                    "base_time": village_base.strftime("%H00"),
                },
            )
            air_future = executor.submit(air_quality_for_location, location_label)
            try:
                observations = observation_future.result()
            except RuntimeError:
                previous = use_previous_weather()
                if previous:
                    return previous
                return jsonify(
                    {
                        "error": "현재 기상청 서버 응답이 지연되고 있습니다. 잠시 후 다시 시도해 주세요."
                    }
                ), 503
            try:
                forecasts = forecast_future.result()
            except RuntimeError:
                forecasts = []
                forecast_failed = True
            try:
                live_air = air_future.result()
                air_quality = {"ok": True, **live_air}
            except RuntimeError:
                previous_air = (
                    previous_cache[0].get("air_quality") if previous_cache else None
                )
                if previous_air and previous_air.get("ok"):
                    air_quality = {**previous_air, "stale": True}
                else:
                    air_quality = {
                        "ok": False,
                        "message": "현재 대기질 서버 응답이 지연되고 있어요. 잠시 후 다시 확인해 주세요.",
                    }
    except Exception:
        previous = use_previous_weather()
        if previous:
            return previous
        return jsonify(
            {"error": "현재 기상 정보를 불러오지 못했어요. 잠시 후 다시 시도해 주세요."}
        ), 503

    observed = {item.get("category"): item.get("obsrValue") for item in observations}
    forecast_by_time = {}
    for item in forecasts:
        category = item.get("category")
        if category not in {"TMP", "SKY", "PTY", "POP"}:
            continue
        key = f"{item.get('fcstDate', '')}{item.get('fcstTime', '')}"
        forecast_by_time.setdefault(key, {})[category] = item.get("fcstValue")

    next_forecasts = []
    for key, values in sorted(forecast_by_time.items()):
        try:
            date = datetime.strptime(key[:8], "%Y%m%d")
            hour, minute = int(key[8:10]), int(key[10:12])
            if hour == 24:
                date += timedelta(days=1)
                hour = 0
            forecast_time = datetime(
                date.year, date.month, date.day, hour, minute, tzinfo=now.tzinfo
            )
        except (ValueError, IndexError):
            continue
        if forecast_time < now:
            continue
        next_forecasts.append(
            {
                "time": forecast_time.strftime("%H:%M"),
                "temperature": numeric(values.get("TMP")),
                "condition": kma_condition(values.get("PTY", "0"), values.get("SKY")),
                "rain_probability": numeric(values.get("POP")),
            }
        )
        if len(next_forecasts) == 6:
            break

    if not observations and not next_forecasts:
        previous = use_previous_weather()
        if previous:
            return previous
        return jsonify(
            {
                "error": "현재 기상청 서버에서 자료를 받지 못했어요. 잠시 후 다시 시도해 주세요."
            }
        ), 503

    precipitation = observed.get("PTY", "0")
    current_condition = kma_condition(precipitation, None)
    if str(precipitation) == "0" and next_forecasts:
        current_condition = next_forecasts[0]["condition"]
    current = {
        "temperature": numeric(observed.get("T1H")),
        "humidity": numeric(observed.get("REH")),
        "wind_speed": numeric(observed.get("WSD")),
        "rain_amount": observed.get("RN1", "강수 정보 없음"),
        "condition": current_condition,
        "observed_at": observation_time.strftime("%Y-%m-%d %H:%M"),
    }
    if current["temperature"] is None and next_forecasts:
        current["temperature"] = next_forecasts[0]["temperature"]
    payload = {
        "location": location_label,
        "current": current,
        "forecast": next_forecasts,
        "air_quality": air_quality,
        "updated_at": now.strftime("%Y-%m-%d %H:%M"),
        "source": "기상청 단기예보 조회서비스",
        "notice": "동네예보 격자 기준 자료예요. 실제 날씨와 차이가 있을 수 있습니다."
        if not forecast_failed
        else "단기예보 응답이 지연되어 실황만 표시합니다. 실외 활동 전에는 예보를 다시 확인해 주세요.",
        "cache_status": "live",
    }
    set_weather_cache(cache_key, payload)
    return jsonify(payload)


def xml_response(payload, status=200):
    root = ET.Element("nearbySearch")

    def append(parent, key, value):
        if isinstance(value, dict):
            node = ET.SubElement(parent, key)
            for child_key, child_value in value.items():
                append(node, str(child_key), child_value)
        elif isinstance(value, list):
            for child in value:
                append(parent, key[:-1] if key.endswith("s") else "item", child)
        else:
            node = ET.SubElement(parent, key)
            node.text = "" if value is None else str(value)

    for key, value in payload.items():
        append(root, key, value)
    body = ET.tostring(root, encoding="unicode", xml_declaration=True)
    return Response(body, status=status, content_type="application/xml; charset=utf-8")


@app.get("/")
def home():
    return send_from_directory(app.root_path, "index.html")


@app.get("/__preview-bridge.js")
def preview_bridge():
    return send_from_directory(app.root_path, "__preview-bridge.js")


@app.get("/shiftfit-logo.png")
def shiftfit_logo():
    return send_from_directory(app.root_path, "shiftfit-logo.png", mimetype="image/png")


@app.get("/api/supabase-config")
def supabase_config():
    # This is a publishable key; never expose a service_role key here.
    return jsonify(
        {
            "url": "https://wixmynzdcibpwfligpfl.supabase.co",
            "publishableKey": os.environ.get("SUPABASE_PUBLISHABLE_KEY", "").strip(),
        }
    )


@app.route("/api/nearby", methods=["GET", "POST"])
def nearby():
    params = request.get_json(silent=True) if request.method == "POST" else request.args
    params = params or request.args
    response_format = request.args.get("format", params.get("format", "json")).lower()
    if response_format not in {"json", "xml"}:
        return jsonify({"error": "format은 json 또는 xml이어야 합니다."}), 400
    radius = numeric(params.get("radius", "3"))
    if radius is None or not 0.5 <= radius <= 20:
        return jsonify(
            {"error": "검색 반경은 0.5km부터 20km까지 선택할 수 있습니다."}
        ), 400
    address = str(params.get("address", "")).strip()[:200]
    lat, lon = numeric(params.get("lat")), numeric(params.get("lon"))
    if (lat is None) != (lon is None):
        return jsonify({"error": "위도와 경도를 함께 전달해 주세요."}), 400
    if lat is not None and lon is not None:
        if not (-90 <= lat <= 90 and -180 <= lon <= 180):
            return jsonify({"error": "위치 좌표가 올바르지 않습니다."}), 400
        location_label, province = reverse_geocode(lat, lon)
    elif address:
        try:
            lat, lon, location_label, province = geocode_address(address)
        except ValueError as error:
            return jsonify({"error": str(error)}), 400
        except RuntimeError:
            return jsonify(
                {"error": "주소 검색에 실패했어요. 잠시 후 다시 시도해 주세요."}
            ), 502
    else:
        return jsonify({"error": "주소를 입력하거나 현재 위치를 사용해 주세요."}), 400

    sources = {}
    nearby_results = {"parks": [], "facilities": []}
    providers = (("parks", "parks"), ("eshare", "facilities"))
    with ThreadPoolExecutor(max_workers=2) as executor:
        futures = {
            executor.submit(
                load_provider_records,
                provider,
                response_format,
                province if provider == "eshare" else None,
            ): (provider, result_key)
            for provider, result_key in providers
        }
        for future in as_completed(futures):
            provider, result_key = futures[future]
            try:
                records, total = future.result()
                for item in records:
                    distance = distance_km(lat, lon, item["lat"], item["lon"])
                    if distance <= radius:
                        item["distance_km"] = round(distance, 2)
                        nearby_results[result_key].append(item)
                nearby_results[result_key].sort(key=lambda item: item["distance_km"])
                sources[result_key] = {
                    "ok": True,
                    "total": total,
                    "matched": len(nearby_results[result_key]),
                }
            except Exception:
                sources[result_key] = {
                    "ok": False,
                    "message": "외부 자료 응답이 지연되거나 오류가 있어요. 잠시 후 다시 시도해 주세요.",
                }

    if not any(source["ok"] for source in sources.values()):
        payload = {"error": "주변 정보를 불러오지 못했습니다.", "sources": sources}
        return (
            xml_response(payload, 503)
            if response_format == "xml"
            else (jsonify(payload), 503)
        )

    recommendations = []
    if nearby_results["parks"]:
        recommendations.append(
            {
                "title": "공원에서 가볍게 달리기",
                "text": "가까운 공원까지 걸어가서 편안한 속도로 산책이나 조깅을 해보세요.",
            }
        )
    if nearby_results["facilities"]:
        recommendations.append(
            {
                "title": "근처 체육시설 살펴보기",
                "text": "시설 정보와 운영 여부를 확인한 뒤, 가능한 공간에서 가볍게 움직여 보세요.",
            }
        )
    if not recommendations:
        recommendations.append(
            {
                "title": "주변 결과가 없어요",
                "text": "검색 반경을 넓히거나 다른 주소를 입력해 다시 찾아보세요.",
            }
        )

    payload = {
        "origin": {"lat": lat, "lon": lon, "label": location_label},
        "radius_km": radius,
        "parks": nearby_results["parks"][:20],
        "facilities": nearby_results["facilities"][:20],
        "recommendations": recommendations,
        "sources": sources,
        "notice": "공공데이터의 위치·시설 정보는 최신 현장 상황과 다를 수 있어요. 방문 전 운영 여부를 확인해 주세요.",
    }
    return xml_response(payload) if response_format == "xml" else jsonify(payload)


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=int(os.environ.get("PORT", 3000)))
