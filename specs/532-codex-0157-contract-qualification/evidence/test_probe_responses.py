"""Synthetic current-turn/retry controls; no inference or credentials."""
import unittest
from probe_responses import response_item


def user(text):
    return {"role": "user", "content": [{"type": "input_text", "text": text}]}


class CurrentTurnResponses(unittest.TestCase):
    def test_retried_identical_input_returns_identical_tool_call(self):
        request = {"input": [user("fresh")]}
        self.assertEqual(response_item(request), response_item(request))
        self.assertEqual(response_item(request)["type"], "function_call")

    def test_prior_turn_output_does_not_complete_new_turn(self):
        prior = user("prior")
        prior_call = response_item({"input": [prior]})
        request = {"input": [prior, {"type": "function_call_output", "call_id": prior_call["call_id"], "output": "A"}, user("new")]}
        new_call = response_item(request)
        self.assertEqual(new_call["type"], "function_call")
        self.assertNotEqual(new_call["call_id"], prior_call["call_id"])
        self.assertEqual(response_item(request), new_call)

    def test_same_prompt_new_turn_does_not_reuse_prior_call(self):
        prompt = user("repeat")
        prior = response_item({"input": [prompt]})
        next_request = {"input": [prompt, {"type": "function_call_output", "call_id": prior["call_id"], "output": "A"}, prompt]}
        next_call = response_item(next_request)
        self.assertEqual(next_call["type"], "function_call")
        self.assertNotEqual(next_call["call_id"], prior["call_id"])
        self.assertEqual(response_item(next_request), next_call)

    def test_only_current_matching_output_completes_and_retries_stay_final(self):
        current = user("current")
        call = response_item({"input": [current]})
        wrong = {"input": [current, {"type": "function_call_output", "call_id": "other", "output": "A"}]}
        self.assertEqual(response_item(wrong), call)
        completed = {"input": [current, {"type": "function_call_output", "call_id": call["call_id"], "output": "A"}]}
        self.assertEqual(response_item(completed)["type"], "message")
        self.assertEqual(response_item(completed), response_item(completed))


if __name__ == "__main__":
    unittest.main()
