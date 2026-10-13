import sys
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from evals.finetune_hypatia_laya import finetune_with_device_placement, measure_option_order_bias
from evals.serve_hypatia_laya import checkpoint_fingerprint


class FakeAgent:
    def __init__(self) -> None:
        self.calls = 0

    def predict(self, _state: str, questions: dict[str, Any]) -> dict[str, Any]:
        criteria = questions["relevance"]["criteria"]
        self.calls += 1
        if self.calls % 2:
            self.assert_order(criteria, ("A", "B"))
            probabilities = {"A": 0.8, "B": 0.2} if self.calls == 1 else {"A": 0.7, "B": 0.3}
            choice = "A"
        else:
            self.assert_order(criteria, ("B", "A"))
            probabilities = {"A": 0.2, "B": 0.8} if self.calls == 2 else {"A": 0.6, "B": 0.4}
            choice = "B" if self.calls == 2 else "A"
        return {"answers": {"relevance": {"probabilities": probabilities, "choice": choice}}}

    @staticmethod
    def assert_order(criteria: dict[str, str], expected: tuple[str, str]) -> None:
        if tuple(criteria) != expected:
            raise AssertionError(f"criteria order was {tuple(criteria)}, expected {expected}")


class OptionOrderBiasTest(unittest.TestCase):
    def test_maps_reversed_labels_back_to_useful_and_reports_flip_rate(self) -> None:
        agent = FakeAgent()
        question = {
            "type": "choice",
            "instructions": "Judge usefulness.",
            "criteria": {"A": "Useful", "B": "Not useful"},
        }
        cases = [
            {"state": "first", "questions": {"relevance": question}},
            {"state": "second", "questions": {"relevance": question}},
        ]

        report = measure_option_order_bias(agent, cases)

        self.assertEqual(agent.calls, 4)
        self.assertEqual(report["cases"], 2)
        self.assertEqual(report["decisionFlips"], 1)
        self.assertEqual(report["decisionFlipRate"], 0.5)
        self.assertAlmostEqual(report["meanAbsoluteUsefulProbabilityDelta"], 0.15)


class DevicePlacementTest(unittest.TestCase):
    def test_places_loaded_checkpoint_before_finetune_and_restores_loader(self) -> None:
        class FakeModel:
            def __init__(self) -> None:
                self.devices: list[Any] = []

            def to(self, device: Any) -> "FakeModel":
                self.devices.append(device)
                return self

        model = FakeModel()
        api = SimpleNamespace()

        def load_checkpoint(_model_id: str) -> tuple[FakeModel, str, dict[str, str]]:
            return model, "tokenizer", {"max_len": "512"}

        def finetune(_data: str, _base: str, _output: str, _config: object, device: str) -> dict[str, str]:
            loaded, _, _ = api.load_checkpoint("english")
            if loaded.devices != ["mps"]:
                raise AssertionError("checkpoint was not placed on the selected device before evaluation")
            return {"device": device}

        api.load_checkpoint = load_checkpoint
        api.finetune = finetune

        report = finetune_with_device_placement(api, "train.jsonl", "english", "out", object(), "mps")

        self.assertEqual(report, {"device": "mps"})
        self.assertEqual(api.load_checkpoint, load_checkpoint)

    def test_restores_loader_when_finetune_raises(self) -> None:
        api = SimpleNamespace()

        def load_checkpoint(model_id: str) -> tuple[str, str, dict[str, str]]:
            return model_id, "tokenizer", {}

        def fail(*_args: Any, **_kwargs: Any) -> None:
            raise RuntimeError("training failure")

        api.load_checkpoint = load_checkpoint
        api.finetune = fail

        with self.assertRaisesRegex(RuntimeError, "training failure"):
            finetune_with_device_placement(api, "train.jsonl", "english", "out", object(), "mps")
        self.assertEqual(api.load_checkpoint, load_checkpoint)


class CheckpointFingerprintTest(unittest.TestCase):
    def test_fingerprint_is_stable_and_binds_checkpoint_contents(self) -> None:
        with TemporaryDirectory() as directory:
            checkpoint = Path(directory)
            (checkpoint / "model.safetensors").write_bytes(b"weights")
            (checkpoint / "rl_agent_config.json").write_text("{}", encoding="utf-8")

            first = checkpoint_fingerprint(checkpoint)

            self.assertEqual(first, checkpoint_fingerprint(checkpoint))
            (checkpoint / "model.safetensors").write_bytes(b"changed weights")
            self.assertNotEqual(first, checkpoint_fingerprint(checkpoint))


if __name__ == "__main__":
    unittest.main()
