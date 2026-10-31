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

    def test_very_low_condition_score_prioritizes_rest(self):
        result = self.evaluate(
            conditionScore=34, sleep={"records": [self.good_sleep_record()]}
        )
        self.assertFalse(result["showModal"])
        self.assertEqual(result["reasonCodes"], ["VERY_LOW_CONDITION_SCORE"])

    def test_planned_bedtime_within_an_hour_limits_session(self):
        planned_bedtime = (datetime.now(KST) + timedelta(minutes=30)).isoformat()
        result = self.evaluate(
            sleep={
                "plannedSleepStart": planned_bedtime,
                "records": [self.good_sleep_record()],
            }
        )
        self.assertEqual(self.step_minutes(result), 5)


if __name__ == "__main__":
    unittest.main()
