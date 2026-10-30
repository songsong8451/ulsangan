import json
import logging
import math
import os
import re
import xml.etree.ElementTree as ET
from functools import lru_cache
from urllib.parse import quote

import requests
from dotenv import load_dotenv
from flask import Flask, Response, jsonify, request, send_from_directory

load_dotenv()

app = Flask(__name__, static_folder=None)
logging.getLogger("werkzeug").disabled = True
PARKS_URL = "https://api.data.go.kr/openapi/tn_pubr_public_cty_park_info_api"
ESHARE_URL = "https://www.eshare.go.kr/eshare-openapi/rsrc/list/010500/{}"
NOMINATIM_URL = "https://nominatim.openstreetmap.org"
PAGE_SIZE = 100
MAX_PAGES = {"parks": 20, "eshare": 5}

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
    session = requests.Session()
    records = []
    total = None
    for page in range(1, MAX_PAGES[provider] + 1):
        params = request_params(response_format, page)
        if provider == "parks":
            key = os.environ.get("DATA_GO_KR_SERVICE_KEY", "").strip()
            if not key:
                raise RuntimeError("공원 API 인증키가 서버에 설정되지 않았습니다.")
            params["serviceKey"] = key
            url = PARKS_URL
            headers = {
                "Accept": "application/json"
                if response_format == "json"
                else "application/xml"
            }
        else:
            key = os.environ.get("ESHARE_API_KEY", "").strip()
            if not key:
                raise RuntimeError("공유누리 API 인증키가 서버에 설정되지 않았습니다.")
            url = ESHARE_URL.format(quote(key, safe=""))
            params.pop("type", None)
            if province:
                params["ctpvCd"] = province
            headers = {
                "Accept": "application/json"
                if response_format == "json"
                else "application/xml"
            }
        try:
            response = session.get(url, params=params, headers=headers, timeout=18)
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
        page_records = list(find_records(payload))
        records.extend(page_records)
        if total is None:
            total = find_total(payload)
        if not page_records or (total is not None and page * PAGE_SIZE >= total):
            break
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
        response = requests.get(
            f"{NOMINATIM_URL}/search",
            params={
                "q": address,
                "format": "jsonv2",
                "addressdetails": 1,
                "limit": 1,
                "countrycodes": "kr",
            },
            headers={"User-Agent": "ShiftFitNearby/1.0 (public exercise finder)"},
            timeout=12,
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
        response = requests.get(
            f"{NOMINATIM_URL}/reverse",
            params={
                "lat": lat,
                "lon": lon,
                "format": "jsonv2",
                "zoom": 10,
                "addressdetails": 1,
            },
            headers={"User-Agent": "ShiftFitNearby/1.0 (public exercise finder)"},
            timeout=10,
        )
        response.raise_for_status()
        result = response.json()
        address = result.get("address", {})
        label = ", ".join(
            value
            for value in (
                address.get("city") or address.get("county") or address.get("town"),
                address.get("state"),
            )
            if value
        )
        return label or "현재 위치", region_code(address)
    except (requests.RequestException, ValueError):
        return "현재 위치", None


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
    for provider, result_key in (("parks", "parks"), ("eshare", "facilities")):
        try:
            records, total = load_provider_records(provider, response_format, province)
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
        except RuntimeError:
            sources[result_key] = {
                "ok": False,
                "message": "데이터를 불러오지 못했습니다. 인증키 승인 여부와 서비스 상태를 확인해 주세요.",
            }

    if not any(source["ok"] for source in sources.values()):
        payload = {"error": "주변 정보를 불러오지 못했습니다.", "sources": sources}
        return (
            xml_response(payload, 502)
            if response_format == "xml"
            else (jsonify(payload), 502)
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
