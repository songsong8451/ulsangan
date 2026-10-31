import unittest
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

from app import app


KST = ZoneInfo("Asia/Seoul")


class ActivityRecommendationTests(unittest.TestCase):
    def setUp(self):
        self.client = app.test_client()

    def evaluate(self, **overrides):
        payload = {
            "shift": {"routineType": "휴무", "availableMinutes": 15},
            "sleep": {"records": []},
        }
        payload.update(overrides)
        return self.client.post(
            "/v1/activity-recommendations/evaluate", json=payload
        ).get_json()

    def good_sleep_record(self, date=None, **overrides):
        record = {
            "date": date or datetime.now(KST).date().isoformat(),
            "sleepMinutes": 420,
            "napMinutes": 0,
            "satisfaction": 9,
            "fatigue": 2,
        }
        record.update(overrides)
        return record

    def step_minutes(self, result):
        return sum(
            step["durationMinutes"] for step in result["modal"]["activity"]["steps"]
        )

    def test_stale_fatigue_record_is_treated_as_unknown(self):
        stale_date = (datetime.now(KST).date() - timedelta(days=10)).isoformat()
        result = self.evaluate(
            sleep={"records": [self.good_sleep_record(stale_date, fatigue=9)]}
        )
        self.assertTrue(result["showModal"])
        self.assertEqual(result["reasonCodes"], ["SLEEP_DATA_UNKNOWN"])

    def test_records_are_sorted_before_limiting_to_fourteen(self):
        today = datetime.now(KST).date()
        old_records = [
            self.good_sleep_record((today - timedelta(days=day)).isoformat())
            for day in range(15, 29)
        ]
        latest = self.good_sleep_record(fatigue=9)
        result = self.evaluate(sleep={"records": [*old_records, latest]})
        self.assertFalse(result["showModal"])
        self.assertEqual(result["reasonCodes"], ["HIGH_REPORTED_FATIGUE"])

    def test_available_time_below_three_minutes_suppresses_activity(self):
        result = self.evaluate(shift={"routineType": "휴무", "availableMinutes": 2})
        self.assertFalse(result["showModal"])
        self.assertEqual(result["reasonCodes"], ["NOT_ENOUGH_TIME"])

    def test_steps_are_trimmed_to_available_time(self):
        result = self.evaluate(
            shift={"routineType": "휴무", "availableMinutes": 8},
            sleep={"records": [self.good_sleep_record()]},
        )
        self.assertTrue(result["showModal"])
        self.assertEqual(self.step_minutes(result), 8)

    def test_server_sleep_score_limits_a_medium_score_session(self):
        record = self.good_sleep_record(satisfaction=6, fatigue=4)
        result = self.evaluate(sleep={"records": [record]})
        self.assertEqual(self.step_minutes(result), 10)

    def test_low_sleep_score_reduces_session_to_five_minutes(self):
        record = self.good_sleep_record(satisfaction=1, fatigue=7)
        result = self.evaluate(sleep={"records": [record]})
        self.assertEqual(self.step_minutes(result), 5)

    def test_kss_seven_or_higher_prioritizes_rest(self):
        result = self.evaluate(sleep={"kss": 7, "records": [self.good_sleep_record()]})
        self.assertFalse(result["showModal"])
        self.assertEqual(result["reasonCodes"], ["HIGH_SLEEPINESS"])

    def test_kss_ten_is_valid_and_prioritizes_rest(self):
        result = self.evaluate(sleep={"kss": 10, "records": [self.good_sleep_record()]})
        self.assertFalse(result["showModal"])
        self.assertEqual(result["reasonCodes"], ["HIGH_SLEEPINESS"])

    def test_out_of_range_kss_is_ignored(self):
        for kss in (0, 99):
            with self.subTest(kss=kss):
                result = self.evaluate(
                    sleep={"kss": kss, "records": [self.good_sleep_record()]}
                )
                self.assertTrue(result["showModal"])

    def test_engine_uses_saved_sfs_score_before_fallback_score(self):
        record = self.good_sleep_record(satisfaction=6, fatigue=4)
        record["score"] = {"total": 76}
        saved_score = self.evaluate(sleep={"records": [record]})
        fallback_score = self.evaluate(
            sleep={"records": [self.good_sleep_record(satisfaction=6, fatigue=4)]}
        )
        self.assertEqual(self.step_minutes(saved_score), 15)
        self.assertEqual(self.step_minutes(fallback_score), 10)

    def test_very_low_condition_score_prioritizes_rest(self):
        result = self.evaluate(
            conditionScore=34, sleep={"records": [self.good_sleep_record()]}
        )
        self.assertFalse(result["showModal"])
        self.assertEqual(result["reasonCodes"], ["VERY_LOW_CONDITION_SCORE"])

    def test_shift_dummy_discomfort_field_prevents_exercise_modal(self):
        result = self.evaluate(
            shift={"type": "night", "availableMinutes": 15},
            checkIn={"discomfort": True, "intent": "move"},
            evaluationResult={"showModal": True, "decision": "outdoor_activity"},
            sleep={"records": [self.good_sleep_record()]},
        )
        self.assertFalse(result["showModal"])
        self.assertEqual(result["reasonCodes"], ["USER_REPORTED_DISCOMFORT"])

    def test_shift_dummy_very_sleepy_field_maps_to_kss_rest_gate(self):
        result = self.evaluate(
            shift={"type": "night", "availableMinutes": 15},
            checkIn={
                "discomfort": False,
                "intent": "move",
                "sleepiness": "very_sleepy",
            },
            sleep={"records": [self.good_sleep_record()]},
        )
        self.assertFalse(result["showModal"])
        self.assertEqual(result["reasonCodes"], ["HIGH_SLEEPINESS"])

    def test_shift_dummy_rest_intent_is_respected(self):
        result = self.evaluate(
            checkIn={"discomfort": False, "intent": "rest", "sleepiness": "not_sleepy"},
            sleep={"records": [self.good_sleep_record()]},
        )
        self.assertFalse(result["showModal"])
        self.assertEqual(result["reasonCodes"], ["USER_CHOSE_REST"])

    def test_english_shift_alias_selects_matching_routine(self):
        result = self.evaluate(
            shift={"type": "night", "availableMinutes": 15},
            sleep={"records": [self.good_sleep_record()]},
        )
        self.assertTrue(result["showModal"])
        self.assertEqual(result["modal"]["activity"]["shiftType"], "야간")

    def test_tired_restfulness_selects_short_relaxation_routine(self):
        result = self.evaluate(
            checkIn={"discomfort": False, "intent": "move", "restedness": "tired"},
            sleep={"records": [self.good_sleep_record()]},
        )
        self.assertEqual(self.step_minutes(result), 8)

    def test_csv_energy_score_alias_limits_activity(self):
        result = self.evaluate(
            energy_score=45,
            sleep={"records": [self.good_sleep_record()]},
        )
        self.assertEqual(self.step_minutes(result), 5)

    def test_shift_dummy_next_sleep_start_limits_activity(self):
        next_sleep = (datetime.now(KST) + timedelta(minutes=30)).isoformat()
        result = self.evaluate(
            shift={"type": "night", "availableMinutes": 15},
            nextSleep={"startAt": next_sleep},
            sleep={"records": [self.good_sleep_record()]},
        )
        self.assertEqual(self.step_minutes(result), 5)

    def test_planned_bedtime_within_an_hour_limits_session(self):
        planned_bedtime = (datetime.now(KST) + timedelta(minutes=30)).isoformat()
        result = self.evaluate(
            sleep={
                "plannedSleepStart": planned_bedtime,
                "records": [self.good_sleep_record()],
            }
        )
        self.assertEqual(self.step_minutes(result), 5)


class ParkAfterWorkTimeTests(unittest.TestCase):
    WORK_HOURS = {
        "주간": {"start": "07:00", "end": "15:00"},
        "오후": {"start": "15:00", "end": "23:00"},
        "야간": {"start": "23:00", "end": "07:00"},
    }

    def setUp(self):
        self.client = app.test_client()

    def at(self, day, hour, minute=0):
        return datetime(2026, 11, day, hour, minute, tzinfo=KST)

    def evaluate_at(self, now, shift=None, parks=None):
        from unittest.mock import patch

        fmt = lambda value: value.strftime("%Y-%m-%d %H:%M")
        shift_input = {
            "todayType": "휴무",
            "yesterdayType": "휴무",
            "routineType": "휴무",
            "workHours": self.WORK_HOURS,
            "availableMinutes": 30,
            **(shift or {}),
        }
        payload = {
            "shift": shift_input,
            "sleep": {
                "records": [
                    {
                        "date": now.date().isoformat(),
                        "sleepMinutes": 450,
                        "satisfaction": 9,
                        "fatigue": 2,
                    }
                ]
            },
            "weather": {
                "updated_at": fmt(now - timedelta(minutes=2)),
                "current": {
                    "observed_at": fmt(now - timedelta(minutes=30)),
                    "condition": "맑음",
                },
                "forecast": [{"condition": "맑음", "rain_probability": 0}],
                "air_quality": {
                    "ok": True,
                    "data_time": fmt(now - timedelta(minutes=40)),
                    "pm10": {"grade": "좋음"},
                    "pm25": {"grade": "좋음"},
                },
            },
            "nearby": {"parks": parks or [{"name": "테스트공원", "distance_km": 0.3}]},
        }
        with patch("app.current_kst", return_value=now):
            return self.client.post(
                "/v1/activity-recommendations/evaluate", json=payload
            ).get_json()

    def nearby_recommendations_at(self, now):
        from unittest.mock import patch

        def provider_records(provider, response_format, province):
            if provider == "parks":
                return ([{"name": "테스트공원", "lat": 35.54, "lon": 129.3}], 1)
            return ([], 0)

        with (
            patch("app.current_kst", return_value=now),
            patch("app.reverse_geocode", return_value=("울산", "울산광역시")),
            patch("app.load_provider_records", side_effect=provider_records),
        ):
            response = self.client.post(
                "/api/nearby", json={"lat": 35.54, "lon": 129.3, "radius": 3}
            )
        self.assertEqual(response.status_code, 200)
        return response.get_json()["recommendations"]

    def test_day_shift_end_allows_park_while_still_bright(self):
        result = self.evaluate_at(
            self.at(2, 15, 30),
            {"todayType": "주간", "routineType": "주간"},
        )
        self.assertEqual(result["decision"], "outdoor_activity")

    def test_late_evening_shift_end_uses_indoor_activity(self):
        result = self.evaluate_at(
            self.at(2, 23, 20),
            {"todayType": "오후", "routineType": "오후"},
        )
        self.assertEqual(result["decision"], "indoor_activity")
        self.assertEqual(result["reasonCodes"], ["LATE_SHIFT_END"])
        self.assertIn("23:00 퇴근", result["conditionSummary"])

    def test_recent_night_shift_end_prioritizes_sleep(self):
        result = self.evaluate_at(
            self.at(3, 7, 40),
            {"yesterdayType": "야간", "routineType": "비번"},
        )
        self.assertEqual(result["decision"], "indoor_activity")
        self.assertEqual(result["reasonCodes"], ["AFTER_NIGHT_SHIFT"])

    def test_custom_late_day_shift_end_uses_indoor_activity(self):
        hours = {**self.WORK_HOURS, "주간": {"start": "10:00", "end": "19:00"}}
        result = self.evaluate_at(
            self.at(2, 19, 10),
            {"todayType": "주간", "routineType": "주간", "workHours": hours},
        )
        self.assertEqual(result["reasonCodes"], ["LATE_SHIFT_END"])

    def test_explicit_last_shift_end_is_considered(self):
        result = self.evaluate_at(
            self.at(2, 21),
            {
                "lastShiftEnd": "2026-11-02T20:30:00+09:00",
                "lastShiftType": "주간",
            },
        )
        self.assertEqual(result["reasonCodes"], ["LATE_SHIFT_END"])

    def test_round_trip_that_exceeds_available_time_switches_indoor(self):
        result = self.evaluate_at(
            self.at(2, 15, 30),
            {"todayType": "주간", "routineType": "주간", "availableMinutes": 5},
            parks=[{"name": "먼공원", "distance_km": 1.0}],
        )
        self.assertEqual(result["decision"], "indoor_activity")
        self.assertEqual(result["reasonCodes"], ["NOT_ENOUGH_TIME_FOR_PARK"])

    def test_park_session_that_finishes_after_six_pm_switches_indoor(self):
        result = self.evaluate_at(
            self.at(2, 17, 40),
            {"availableMinutes": 30},
            parks=[{"name": "먼공원", "distance_km": 0.5}],
        )
        self.assertEqual(result["decision"], "indoor_activity")
        self.assertEqual(result["reasonCodes"], ["PARK_TOO_LATE"])

    def test_park_reopens_for_recommendation_after_late_shift_window(self):
        result = self.evaluate_at(
            self.at(3, 10),
            {"yesterdayType": "오후", "routineType": "휴무"},
        )
        self.assertEqual(result["decision"], "outdoor_activity")

    def test_day_off_at_night_does_not_recommend_park(self):
        result = self.evaluate_at(self.at(2, 19, 30))
        self.assertEqual(result["reasonCodes"], ["PARK_ACCESS_UNKNOWN"])

    def test_nearby_page_uses_an_indoor_nudge_after_park_hours(self):
        recommendations = self.nearby_recommendations_at(self.at(2, 19, 30))
        self.assertEqual(recommendations[0]["title"], "공원은 밝은 시간에 이용해요")


if __name__ == "__main__":
    unittest.main()
