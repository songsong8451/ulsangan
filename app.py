import json
import logging
import math
import os
import re
import time
import xml.etree.ElementTree as ET
from concurrent.futures import ThreadPoolExecutor, as_completed
from copy import deepcopy
from datetime import date, datetime, timedelta
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
PARK_EARLIEST_HOUR = 6
PARK_LATEST_HOUR = 18
POST_WORK_WINDOW = timedelta(hours=3)


def current_kst():
    return datetime.now(ZoneInfo("Asia/Seoul"))


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
        "coordinates": {"lat": lat, "lon": lon},
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


@app.get("/sleep-score.js")
def sleep_score_script():
    return send_from_directory(
        app.root_path, "sleep-score.js", mimetype="application/javascript"
    )


@app.get("/sfs100.js")
def sfs100_script():
    return send_from_directory(
        app.root_path, "sfs100.js", mimetype="application/javascript"
    )


@app.get("/watch-monitor.js")
def watch_monitor_script():
    return send_from_directory(
        app.root_path, "watch-monitor.js", mimetype="application/javascript"
    )


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
        if PARK_EARLIEST_HOUR <= current_kst().hour < PARK_LATEST_HOUR:
            recommendations.append(
                {
                    "title": "공원에서 가볍게 걷기",
                    "text": "가까운 공원까지 걸어가서 편안한 속도로 산책해 보세요.",
                }
            )
        else:
            recommendations.append(
                {
                    "title": "공원은 밝은 시간에 이용해요",
                    "text": "지금은 늦은 시간이라 공원 대신 실내에서 가볍게 움직여 보세요. 공원 목록은 다음에 참고하세요.",
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


def shift_interval_for_day(day, shift_type, work_hours):
    if shift_type not in {"주간", "오후", "야간"}:
        return None
    times = work_hours.get(shift_type, {}) if isinstance(work_hours, dict) else {}
    start_text, end_text = times.get("start"), times.get("end")
    if not start_text or not end_text:
        return None
    try:
        start_time = datetime.strptime(start_text, "%H:%M").time()
        end_time = datetime.strptime(end_text, "%H:%M").time()
    except ValueError:
        return None
    start = datetime.combine(day, start_time, tzinfo=ZoneInfo("Asia/Seoul"))
    end = datetime.combine(day, end_time, tzinfo=ZoneInfo("Asia/Seoul"))
    if end <= start:
        end += timedelta(days=1)
    return start, end


def last_shift_end(now, shift, work_hours):
    aliases = {"day": "주간", "evening": "오후", "night": "야간", "off": "휴무"}
    explicit = shift.get("lastShiftEnd") or shift.get("prevShiftEnd")
    if explicit:
        try:
            end = datetime.fromisoformat(str(explicit).replace("Z", "+00:00"))
            if end.tzinfo is None:
                end = end.replace(tzinfo=ZoneInfo("Asia/Seoul"))
            end = end.astimezone(ZoneInfo("Asia/Seoul"))
            if end <= now:
                shift_type = shift.get("lastShiftType") or shift.get("prevShiftType")
                return aliases.get(shift_type, shift_type), end
        except ValueError:
            pass

    latest = None
    for offset, key in ((-1, "yesterdayType"), (0, "todayType")):
        shift_type = shift.get(key)
        interval = shift_interval_for_day(
            now.date() + timedelta(days=offset), shift_type, work_hours
        )
        if (
            interval
            and interval[1] <= now
            and (latest is None or interval[1] > latest[1])
        ):
            latest = (shift_type, interval[1])
    return latest


def late_shift_end_reason(now, shift, work_hours):
    found = last_shift_end(now, shift, work_hours)
    if not found:
        return None
    shift_type, end = found
    if now - end > POST_WORK_WINDOW:
        return None
    shift_type = {"day": "주간", "evening": "오후", "night": "야간", "off": "휴무"}.get(
        shift_type, shift_type
    )
    end_text = end.strftime("%H:%M")
    if shift_type == "야간":
        return (
            "AFTER_NIGHT_SHIFT",
            f"야간 근무를 {end_text}에 마쳤어요. 퇴근 후에는 수면이 먼저라 공원 대신 실내에서 가볍게 풀어요.",
        )
    if end.hour >= PARK_LATEST_HOUR or end.hour < PARK_EARLIEST_HOUR:
        return (
            "LATE_SHIFT_END",
            f"{end_text} 퇴근으로 늦은 시간이라 공원은 권하지 않아요. 실내에서 가볍게 풀어요.",
        )
    return None


def activity_response(show_modal, decision, reason, message, summary, modal=None):
    return jsonify(
        {
            "showModal": show_modal,
            "decision": decision,
            "reasonCodes": [reason],
            "message": message,
            "conditionSummary": summary,
            "modal": modal,
        }
    )


RECENT_SLEEP_WINDOW = timedelta(hours=36)
MIN_ACTIVITY_MINUTES = 3


def parse_activity_sleep_date(record):
    try:
        return datetime.strptime(str(record.get("date", "")), "%Y-%m-%d").replace(
            hour=12, tzinfo=ZoneInfo("Asia/Seoul")
        )
    except ValueError:
        return None


def activity_sleep_score(record, total_minutes):
    domains = []
    if total_minutes is not None:
        if total_minutes <= 240:
            duration_score = 0
        elif total_minutes < 360:
            duration_score = (total_minutes - 240) / 120 * 60
        elif total_minutes < 420:
            duration_score = 60 + (total_minutes - 360) / 60 * 40
        else:
            duration_score = 100
        domains.append(duration_score)

    continuity = []
    for key, good, poor in (
        ("latencyMin", 30, 45),
        ("wasoMin", 20, 41),
        ("awakenings", 1, 4),
    ):
        value = numeric(record.get(key))
        if value is not None:
            continuity.append(max(0, min(100, (poor - value) / (poor - good) * 100)))

    efficiency = numeric(record.get("efficiencyPct"))
    if efficiency is None:
        in_bed = numeric(record.get("inBedMinutes"))
        sleep_minutes = numeric(record.get("sleepMinutes"))
        if in_bed and in_bed > 0 and sleep_minutes is not None:
            efficiency = sleep_minutes / in_bed * 100
    if efficiency is not None:
        continuity.append(max(0, min(100, (efficiency - 64) / (85 - 64) * 100)))
    if continuity:
        domains.append(sum(continuity) / len(continuity))

    satisfaction = numeric(record.get("satisfaction"))
    if satisfaction is not None:
        domains.append((max(1, min(10, satisfaction)) - 1) / 9 * 100)
    fatigue = numeric(record.get("fatigue"))
    if fatigue is not None:
        domains.append((10 - max(1, min(10, fatigue))) / 9 * 100)

    if len(domains) < 2:
        return None
    return math.floor(sum(domains) / len(domains) + 0.5)


def activity_step_limit(steps, minutes):
    if minutes is None:
        return steps
    remaining = minutes
    limited = []
    for step in steps:
        duration = numeric(step.get("durationMinutes"))
        if duration is None or duration <= 0:
            continue
        if duration <= remaining:
            limited.append(step)
            remaining -= int(duration)
        elif remaining >= MIN_ACTIVITY_MINUTES:
            limited.append({**step, "durationMinutes": remaining})
            break
        else:
            break
    return limited


def parse_activity_datetime(value):
    try:
        parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=ZoneInfo("Asia/Seoul"))
    return parsed.astimezone(ZoneInfo("Asia/Seoul"))


ACTIVITY_VIDEOS = {
    "neck": {
        "id": "ArfC7aXAOKY",
        "title": "목 스트레칭과 근력강화운동",
    },
    "shoulder": {
        "id": "4Z2L9YwF2w0",
        "title": "어깨 스트레칭과 근력강화운동",
    },
    "ankle": {
        "id": "XzT2W0DWPe0",
        "title": "발목 스트레칭과 근력강화운동",
    },
    "back": {
        "id": "iO6BF70mCm4",
        "title": "허리 스트레칭과 근력강화운동",
    },
}
ACTIVITY_ROUTINES = {
    "주간": {
        "title": "상쾌한 전신 활력 체조",
        "body": "주간 근무 전에 목·어깨와 발목을 편안한 범위에서 풀며 천천히 몸을 깨워 보세요.",
        "videos": ["neck", "shoulder", "ankle"],
    },
    "오후": {
        "title": "하체 이완 및 스트레칭",
        "body": "오후 근무 전에 발목과 하체를 가볍게 움직이고 어깨도 천천히 풀어 보세요.",
        "videos": ["ankle", "shoulder", "neck"],
    },
    "야간": {
        "title": "야간 대비 이완 루틴",
        "body": "야간 근무 전에 허리와 어깨를 통증 없는 범위에서 부드럽게 움직여 보세요.",
        "videos": ["back", "shoulder", "neck"],
    },
    "비번": {
        "title": "가벼운 리프레시 풀코스 웰니스 세션",
        "body": "비번에는 몸 상태에 맞춰 쉬거나, 목·어깨와 발목을 편안한 속도로 풀어 보세요.",
        "videos": ["shoulder", "ankle", "neck"],
    },
    "휴무": {
        "title": "가벼운 리프레시 풀코스 웰니스 세션",
        "body": "휴무에는 몸 상태에 맞춰 쉬거나, 목·어깨와 발목을 편안한 속도로 풀어 보세요.",
        "videos": ["shoulder", "ankle", "neck"],
    },
}


def activity_routine_steps(shift_type, durations=None, video_keys=None):
    routine = ACTIVITY_ROUTINES.get(shift_type, ACTIVITY_ROUTINES["휴무"])
    durations = durations or [5, 5, 5]
    video_keys = video_keys or routine["videos"]
    steps = []
    for index, (video_key, duration) in enumerate(zip(video_keys, durations), start=1):
        video = ACTIVITY_VIDEOS[video_key]
        step_title = video["title"].replace("과 근력강화운동", "")
        steps.append(
            {
                "id": f"{shift_type}-{video_key}-{index}",
                "title": step_title,
                "durationMinutes": duration,
                "description": "영상 속 동작은 통증 없는 범위에서 편안한 속도로 따라 해요. 불편하면 건너뛰거나 멈춰도 괜찮아요.",
                "videoId": video["id"],
                "videoTitle": video["title"],
                "videoChannel": "울산광역시 취약노동자 건강증진센터",
                "videoUrl": f"https://www.youtube.com/watch?v={video['id']}",
            }
        )
    return steps


@app.post("/v1/activity-recommendations/evaluate")
def evaluate_activity_recommendation():
    data = request.get_json(silent=True) or {}
    now = current_kst()
    today = now.date()
    shift = data.get("shift") if isinstance(data.get("shift"), dict) else {}
    check_in = data.get("checkIn") if isinstance(data.get("checkIn"), dict) else {}
    shift_aliases = {
        "day": "주간",
        "evening": "오후",
        "night": "야간",
        "off": "휴무",
        "주간": "주간",
        "오후": "오후",
        "야간": "야간",
        "비번": "비번",
        "휴무": "휴무",
    }
    shift_type = shift.get(
        "routineType",
        shift.get(
            "todayType",
            shift_aliases.get(shift.get("type", data.get("shift_pattern")), "휴무"),
        ),
    )
    if shift_type not in ACTIVITY_ROUTINES:
        shift_type = "휴무"
    work_hours = shift.get("workHours", {})
    if data.get("discomfort") is True or check_in.get("discomfort") is True:
        return activity_response(
            False,
            "rest",
            "USER_REPORTED_DISCOMFORT",
            "몸이 불편하다고 하셔서 오늘은 운동 루틴을 열지 않을게요. 편하게 쉬고, 통증이 계속되면 의료진과 상의해 주세요.",
            "몸의 불편함을 우선해 운동 제안을 쉬고 있어요.",
        )
    if check_in.get("intent") == "rest":
        return activity_response(
            False,
            "rest",
            "USER_CHOSE_REST",
            "쉬고 싶다고 선택하셔서 운동 제안은 쉬어 갈게요.",
            "사용자의 휴식 선택을 우선했어요.",
        )
    for offset, key in ((-1, "yesterdayType"), (0, "todayType")):
        shift_day = today + timedelta(days=offset)
        interval = shift_interval_for_day(shift_day, shift.get(key), work_hours)
        if interval and interval[0] <= now < interval[1]:
            if shift.get("onBreak") and interval[1] > now + timedelta(minutes=5):
                continue
            return activity_response(
                False,
                "suppress",
                "WORKING_SHIFT",
                "현재는 근무 시간으로 설정되어 있어요. 허용된 휴게시간이 아니라면 운동 제안은 쉬어 갈게요.",
                "근무시간을 우선 보호하고 있어요.",
            )

    next_shift_start = shift.get("nextShiftStart")
    if next_shift_start:
        try:
            next_start = datetime.fromisoformat(
                str(next_shift_start).replace("Z", "+00:00")
            )
            if next_start.tzinfo is None:
                next_start = next_start.replace(tzinfo=ZoneInfo("Asia/Seoul"))
            next_start = next_start.astimezone(ZoneInfo("Asia/Seoul"))
            if now < next_start <= now + timedelta(minutes=15):
                return activity_response(
                    False,
                    "suppress",
                    "NEXT_SHIFT_SOON",
                    "다음 근무까지 여유가 부족해요. 출근 준비와 휴식을 먼저 챙겨 주세요.",
                    "다음 근무 준비 시간을 보호하고 있어요.",
                )
        except ValueError:
            pass

    available = numeric(shift.get("availableMinutes"))
    if available is not None and available < MIN_ACTIVITY_MINUTES:
        return activity_response(
            False,
            "suppress",
            "NOT_ENOUGH_TIME",
            "지금은 쓸 수 있는 시간이 짧아요. 다음 여유 시간에 다시 알려 드릴게요.",
            "가용 시간이 3분 미만이에요.",
        )
    available_limit = math.floor(available) if available is not None else None

    sleep_data = data.get("sleep") if isinstance(data.get("sleep"), dict) else {}
    if sleep_data.get("isSleeping") is True:
        return activity_response(
            False,
            "suppress",
            "PLANNED_SLEEP",
            "예정된 수면 시간은 방해하지 않을게요. 충분히 쉬어 주세요.",
            "수면 보호 시간을 적용했어요.",
        )
    kss = numeric(sleep_data.get("kss", data.get("kss")))
    if kss is not None and not 1 <= kss <= 10:
        kss = None
    if kss is None:
        kss = {
            "not_sleepy": 2,
            "slightly_sleepy": 5,
            "very_sleepy": 8,
        }.get(check_in.get("sleepiness"))
    if kss is not None and kss >= 7:
        return activity_response(
            False,
            "rest",
            "HIGH_SLEEPINESS",
            "졸림 정도가 높게 기록되어 있어요. 지금은 운동보다 안전과 휴식을 우선해 주세요.",
            "졸림 척도(KSS) 응답을 참고해 휴식을 우선하고 있어요.",
        )
    condition_score = numeric(
        data.get("conditionScore", data.get("energy_score", data.get("energyScore")))
    )
    if condition_score is not None and not 0 <= condition_score <= 100:
        condition_score = None
    if condition_score is not None and condition_score < 35:
        return activity_response(
            False,
            "rest",
            "VERY_LOW_CONDITION_SCORE",
            "컨디션 점수가 매우 낮아 오늘은 운동보다 휴식을 우선해 주세요.",
            "매우 낮은 컨디션 점수를 참고해 휴식을 우선하고 있어요.",
        )
    next_sleep = (
        data.get("nextSleep") if isinstance(data.get("nextSleep"), dict) else {}
    )
    planned_sleep = parse_activity_datetime(
        sleep_data.get("plannedSleepStart", next_sleep.get("startAt"))
    )
    near_planned_sleep = bool(
        planned_sleep and now < planned_sleep <= now + timedelta(minutes=60)
    )

    records = sleep_data.get("records", [])
    if not isinstance(records, list):
        records = []
    recent = sorted(
        (record for record in records if isinstance(record, dict)),
        key=lambda record: str(record.get("date", "")),
        reverse=True,
    )[:14]
    latest = next(
        (
            record
            for record in recent
            if (record_date := parse_activity_sleep_date(record)) is not None
            and timedelta(hours=-12) <= now - record_date <= RECENT_SLEEP_WINDOW
        ),
        None,
    )
    total_minutes = None
    fatigue = numeric(latest.get("fatigue")) if latest else None
    satisfaction = numeric(latest.get("satisfaction")) if latest else None
    sleep_unknown = latest is None
    sleep_score = None
    if latest:
        main_sleep = numeric(latest.get("sleepMinutes"))
        nap_sleep = numeric(latest.get("napMinutes", 0)) or 0
        total_minutes = main_sleep + nap_sleep if main_sleep is not None else None
        saved_score = (
            latest.get("score") if isinstance(latest.get("score"), dict) else {}
        )
        sleep_score = numeric(saved_score.get("total"))
        if sleep_score is not None and not 0 <= sleep_score <= 100:
            sleep_score = None
        if sleep_score is None:
            sleep_score = activity_sleep_score(latest, total_minutes)
    if fatigue is not None and fatigue >= 8:
        return activity_response(
            False,
            "suppress",
            "HIGH_REPORTED_FATIGUE",
            "최근 기상 후 피로도가 높게 기록되어 있어요. 오늘은 운동보다 푹 쉬는 것을 우선해 주세요.",
            "최근 수면 기록의 피로도 응답을 참고해 휴식을 우선하고 있어요.",
        )
    if total_minutes is not None and total_minutes < 240:
        return activity_response(
            False,
            "suppress",
            "SHORT_SLEEP",
            "최근 수면 기록이 짧아요. 운동으로 수면을 대신하지 말고 휴식을 우선해 주세요.",
            "최근 수면시간을 참고해 휴식을 우선하고 있어요.",
        )

    if sleep_score is not None and sleep_score < 55:
        sleep_limit = 5
    elif sleep_score is not None and sleep_score < 75:
        sleep_limit = 10
    else:
        sleep_limit = None
    if condition_score is not None and condition_score < 55:
        condition_limit = 5
    elif condition_score is not None and condition_score < 75:
        condition_limit = 10
    else:
        condition_limit = None
    low_condition = (
        data.get("comfortLevel") == "low" or check_in.get("restedness") == "tired"
    )
    light_session = (
        sleep_unknown
        or (total_minutes is not None and total_minutes < 360)
        or (fatigue is not None and fatigue >= 6)
        or (satisfaction is not None and satisfaction <= 3)
        or (sleep_score is not None and sleep_score < 55)
        or near_planned_sleep
    )
    weather = data.get("weather") if isinstance(data.get("weather"), dict) else None
    nearby = data.get("nearby") if isinstance(data.get("nearby"), dict) else None
    weather_unknown = (
        not weather
        or not isinstance(weather.get("current"), dict)
        or weather.get("stale")
    )
    if weather and not weather_unknown:
        try:
            fetched = datetime.strptime(
                weather.get("updated_at", ""), "%Y-%m-%d %H:%M"
            ).replace(tzinfo=ZoneInfo("Asia/Seoul"))
            observed = datetime.strptime(
                weather["current"].get("observed_at", ""), "%Y-%m-%d %H:%M"
            ).replace(tzinfo=ZoneInfo("Asia/Seoul"))
            weather_unknown = now - fetched > timedelta(
                minutes=10
            ) or now - observed > timedelta(minutes=120)
        except (TypeError, ValueError):
            weather_unknown = True
    air = weather.get("air_quality", {}) if weather else {}
    air_unknown = not air.get("ok") or air.get("stale", False)
    if air.get("ok"):
        try:
            air_time = datetime.strptime(
                air.get("data_time", ""), "%Y-%m-%d %H:%M"
            ).replace(tzinfo=ZoneInfo("Asia/Seoul"))
            air_unknown = now - air_time > timedelta(minutes=180)
        except (TypeError, ValueError):
            air_unknown = True
    air_grades = [air.get("pm10", {}).get("grade"), air.get("pm25", {}).get("grade")]
    air_bad = any(grade in {"나쁨", "매우 나쁨"} for grade in air_grades)
    current_condition = (
        str(weather.get("current", {}).get("condition", "")) if weather else ""
    )
    forecast = weather.get("forecast", []) if weather else []
    forecast_conditions = [
        str(item.get("condition", ""))
        for item in forecast[:2]
        if isinstance(item, dict)
    ]
    rain_or_snow = any(
        any(word in condition for word in ("비", "눈", "소나기", "빗방울"))
        for condition in [current_condition, *forecast_conditions]
    ) or any(
        (numeric(item.get("rain_probability")) or 0) >= 50
        for item in forecast[:2]
        if isinstance(item, dict)
    )

    reason = None
    if weather_unknown or air_unknown or not forecast:
        reason = "ENVIRONMENT_DATA_UNKNOWN"
        summary = "날씨 또는 대기질 자료가 최신이 아니어서 실외 제안은 제외했어요."
    elif air_bad:
        reason = "AIR_QUALITY_POOR"
        summary = "주변 측정소 대기질을 고려해 실내 활동을 준비했어요."
    elif rain_or_snow:
        reason = "RAIN_OR_SNOW"
        summary = "현재 또는 가까운 시간의 비·눈 예보를 고려해 실내 활동을 준비했어요."
    else:
        summary = "수면·근무와 최신 날씨·대기질을 확인했어요."

    if reason is None:
        late_end = late_shift_end_reason(now, shift, work_hours)
        if late_end:
            reason, summary = late_end
    if reason is None and (
        now.hour < PARK_EARLIEST_HOUR or now.hour >= PARK_LATEST_HOUR
    ):
        reason = "PARK_ACCESS_UNKNOWN"
        summary = (
            "늦은 시간이라 공원 개방·조명을 확인할 수 없어 실외 제안은 제외했어요."
        )

    parks = nearby.get("parks", []) if nearby else []
    park = None
    if reason is None and isinstance(parks, list):
        candidates = [
            item
            for item in parks
            if isinstance(item, dict) and numeric(item.get("distance_km")) is not None
        ]
        if candidates:
            park = min(candidates, key=lambda item: numeric(item.get("distance_km")))
    if reason is None and park is None:
        reason = "NO_VERIFIED_PARK"
        summary = "가까운 공원 정보를 확인하지 못해 실내 활동을 준비했어요."

    if low_condition:
        mode = "indoor_activity"
        reason = "LOW_COMFORT_SELECTED"
        duration = 8
        title = "8분 가벼운 호흡 및 이완 스트레칭"
        body = "컨디션이 낮다고 선택하셔서 고강도 동작을 제외했어요. 호흡을 고르고 목·어깨를 편안한 범위에서 풀어 주세요."
        summary = (
            "컨디션이 낮아 추천 루틴을 조정했어요 · 8분 가벼운 호흡 및 이완 스트레칭"
        )
        steps = activity_routine_steps(shift_type, [4, 4], ["neck", "shoulder"])
        steps[0]["title"] = "호흡과 목 이완"
        steps[0]["description"] = (
            "숨을 편안하게 내쉬며 목을 통증 없는 범위에서 천천히 움직여요."
        )
        steps[1]["title"] = "어깨 이완 스트레칭"
        steps[1]["description"] = (
            "어깨에 힘을 빼고 영상 속 동작을 편안한 범위에서 따라 해요."
        )
    elif light_session:
        mode = "indoor_activity"
        reason = reason or "LOW_RECOVERY_SELF_REPORT"
        duration = 5
        short_title = ACTIVITY_ROUTINES[shift_type]["title"].replace(" 풀코스", "")
        title = f"{short_title} · 5분 가볍게"
        if sleep_unknown:
            reason = "SLEEP_DATA_UNKNOWN"
            body = "수면 기록이 없어 컨디션을 추정하지 않았어요. 원한다면 부담이 적은 5분 실내 동작을 볼 수 있어요."
            summary = "수면 기록이 없어 짧은 실내 루틴만 준비했어요."
        else:
            body = "최근 수면시간과 만족도·피로도를 참고해 5분 실내 루틴으로 준비했어요. 운동은 선택 사항입니다."
            summary = "최근 수면 기록을 참고해 짧은 실내 활동을 준비했어요."
        steps = activity_routine_steps(shift_type, [5])
    elif reason is not None:
        mode = "indoor_activity"
        duration = 15
        title = ACTIVITY_ROUTINES[shift_type]["title"]
        body = f"{ACTIVITY_ROUTINES[shift_type]['body']} 원하지 않으면 언제든 멈출 수 있어요."
        steps = activity_routine_steps(shift_type)
    else:
        mode = "outdoor_activity"
        duration = 15
        distance = numeric(park.get("distance_km")) or 0
        walk_one_way = math.ceil(distance * 15)
        estimated_total = duration + walk_one_way * 2
        title = ACTIVITY_ROUTINES[shift_type]["title"]
        body = f"{ACTIVITY_ROUTINES[shift_type]['body']} {park.get('name', '가까운 공원')} 주변에서 편안한 걷기를 선택할 수 있어요."
        summary = f"{current_condition} · 주변 측정소 대기질 {air_grades[0]}/{air_grades[1]} · 공원 정보 확인됨"
        steps = activity_routine_steps(shift_type)
        summary += f" · 공원까지 {distance:.1f}km"

    time_limits = [
        limit
        for limit in (
            available_limit,
            sleep_limit,
            condition_limit,
            5 if near_planned_sleep else None,
        )
        if limit is not None
    ]
    original_duration = duration
    if time_limits:
        steps = activity_step_limit(steps, min(time_limits))
    step_total = sum(step["durationMinutes"] for step in steps)
    if mode == "outdoor_activity":
        walk_minutes = walk_one_way * 2
        park_activity_budget = (
            available_limit - walk_minutes if available_limit is not None else None
        )
        if (
            park_activity_budget is not None
            and park_activity_budget < MIN_ACTIVITY_MINUTES
        ):
            mode = "indoor_activity"
            reason = "NOT_ENOUGH_TIME_FOR_PARK"
            body = f"{ACTIVITY_ROUTINES[shift_type]['body']} 원하지 않으면 언제든 멈출 수 있어요."
            summary = "공원까지 오가는 시간이 부족해 실내 루틴으로 준비했어요."
        else:
            if park_activity_budget is not None and step_total > park_activity_budget:
                steps = activity_step_limit(steps, park_activity_budget)
                step_total = sum(step["durationMinutes"] for step in steps)
            park_deadline = now.replace(
                hour=PARK_LATEST_HOUR, minute=0, second=0, microsecond=0
            )
            projected_end = now + timedelta(minutes=walk_minutes + step_total)
            if projected_end > park_deadline:
                mode = "indoor_activity"
                reason = "PARK_TOO_LATE"
                body = f"{ACTIVITY_ROUTINES[shift_type]['body']} 원하지 않으면 언제든 멈출 수 있어요."
                summary = f"공원까지 오가면 {PARK_LATEST_HOUR}시를 넘겨 끝나서 실내 루틴으로 준비했어요."
    if step_total < original_duration:
        summary += f" · 조건과 가용 시간에 맞춰 {step_total}분으로 조정했어요."
        if title.startswith(f"{original_duration}분"):
            title = title.replace(f"{original_duration}분", f"{step_total}분", 1)
    return jsonify(
        {
            "showModal": True,
            "decision": mode,
            "reasonCodes": [reason] if reason else ["WEATHER_AND_AIR_OK"],
            "conditionSummary": summary,
            "modal": {
                "title": title,
                "body": body,
                "recommendedTime": f"약 {step_total}분 활동",
                "activity": {
                    "contentId": "reviewed-light-routine",
                    "durationMinutes": step_total,
                    "shiftType": shift_type,
                    "steps": steps,
                },
                "actions": ["start_session", "dismiss"],
                "notice": (
                    "컨디션이 낮다면 영상 속 근력 동작은 건너뛰고 호흡과 편안한 스트레칭만 해도 괜찮아요. 통증·어지럼이 있으면 멈춰 주세요."
                    if low_condition
                    else "공공기관의 일반 운동 안내 영상입니다. 무리하지 말고 통증·어지럼이 있으면 멈춰 주세요. 의료 처방이나 수면 치료가 아닙니다."
                ),
            },
        }
    )


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=int(os.environ.get("PORT", 3000)))
