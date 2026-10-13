#!/usr/bin/env python3
"""Fine-tune Laya locally and measure A/B option-order sensitivity."""

import argparse
import json
from pathlib import Path
from statistics import mean
from typing import Any


def read_jsonl(path: Path) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for line_number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), start=1):
        if not line.strip():
            continue
        row = json.loads(line)
        if not isinstance(row, dict):
            raise ValueError(f"{path.name} line {line_number} must contain an object.")
        rows.append(row)
    if not rows:
        raise ValueError(f"{path.name} contains no cases.")
    return rows


def prediction_fields(result: dict[str, Any]) -> tuple[float, bool]:
    answer = result["answers"]["relevance"]
    probabilities = answer["probabilities"]
    useful_probability = probabilities["A"]
    choice = answer["choice"]
    if not isinstance(useful_probability, (int, float)) or not 0 <= useful_probability <= 1:
        raise ValueError("Laya returned an invalid relevance probability.")
    if choice not in ("A", "B"):
        raise ValueError("Laya returned an invalid relevance choice.")
    return float(useful_probability), choice == "A"


def measure_option_order_bias(agent: Any, cases: list[dict[str, Any]]) -> dict[str, Any]:
    probability_deltas: list[float] = []
    decision_flips = 0
    for index, case in enumerate(cases, start=1):
        question = case["questions"]["relevance"]
        criteria = question["criteria"]
        normal = agent.predict(case["state"], {"relevance": question})
        normal_probability, normal_choice = prediction_fields(normal)

        reversed_question = {
            **question,
            "criteria": {"B": criteria["A"], "A": criteria["B"]},
        }
        reversed_result = agent.predict(case["state"], {"relevance": reversed_question})
        reversed_answer = reversed_result["answers"]["relevance"]
        reversed_useful_probability = reversed_answer["probabilities"]["B"]
        reversed_choice = reversed_answer["choice"]
        if not isinstance(reversed_useful_probability, (int, float)) or not 0 <= reversed_useful_probability <= 1:
            raise ValueError(f"Laya returned an invalid reversed relevance probability on case {index}.")
        if reversed_choice not in ("A", "B"):
            raise ValueError(f"Laya returned an invalid reversed relevance choice on case {index}.")
        probability_deltas.append(abs(normal_probability - float(reversed_useful_probability)))
        if normal_choice != (reversed_choice == "B"):
            decision_flips += 1

    return {
        "cases": len(cases),
        "decisionFlips": decision_flips,
        "decisionFlipRate": decision_flips / len(cases),
        "meanAbsoluteUsefulProbabilityDelta": mean(probability_deltas),
        "interpretation": "Compare the same paper with useful/not-useful option labels reversed; lower is more stable.",
    }


def finetune_with_device_placement(
    train_api: Any,
    data: str,
    base: str,
    output: str,
    config: Any,
    device: Any,
) -> dict[str, Any]:
    # Laya 0.4.1 evaluates the base model before train_model moves it off CPU.
    # Place the checkpoint at load time so that this first calibration pass matches device.
    original_load_checkpoint = train_api.load_checkpoint

    def load_checkpoint_on_device(model_id: str) -> tuple[Any, Any, Any]:
        model, tokenizer, checkpoint_config = original_load_checkpoint(model_id)
        return model.to(device), tokenizer, checkpoint_config

    train_api.load_checkpoint = load_checkpoint_on_device
    try:
        return train_api.finetune(data, base, output, config, device=str(device))
    finally:
        train_api.load_checkpoint = original_load_checkpoint


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--train", required=True, type=Path)
    parser.add_argument("--holdout", type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--base", default="english")
    parser.add_argument("--device", default="auto")
    parser.add_argument("--epochs", default=4, type=int)
    parser.add_argument("--seed", default=0, type=int)
    args = parser.parse_args()

    train_path = args.train.resolve()
    holdout_path = args.holdout.resolve() if args.holdout else None
    output_path = args.output.resolve()
    if holdout_path is not None and train_path == holdout_path:
        raise ValueError("training and held-out data paths must be different.")
    if not train_path.is_file():
        raise ValueError("training JSONL file must exist.")
    if holdout_path is not None and not holdout_path.is_file():
        raise ValueError("held-out JSONL file must exist.")
    if output_path.exists():
        raise ValueError(f"output path already exists: {output_path}")
    if args.epochs < 1:
        raise ValueError("--epochs must be positive.")

    bias_cases = read_jsonl(holdout_path or train_path)
    from laya import load
    import laya.train as laya_train

    resolved_device = laya_train.resolve_device(args.device)
    report = finetune_with_device_placement(
        laya_train,
        str(train_path),
        args.base,
        str(output_path),
        laya_train.TrainConfig(
            epochs=args.epochs,
            seed=args.seed,
            shuffle_options=("choice",),
            eval_data=str(holdout_path) if holdout_path else None,
        ),
        resolved_device,
    )
    agent = load(str(output_path))
    order_bias = measure_option_order_bias(agent, bias_cases)
    final_report = {
        "base": args.base,
        "deviceRequested": args.device,
        "deviceResolved": str(resolved_device),
        "evaluationScope": "query-disjoint held-out cases" if holdout_path else "training-only diagnostic; no generalization evidence",
        "training": report,
        "optionOrderBiasDataset": "holdout" if holdout_path else "training",
        "optionOrderBias": order_bias,
    }
    report_path = output_path / "hypatia-training-report.json"
    report_path.write_text(f"{json.dumps(final_report, indent=2)}\n", encoding="utf-8")
    print(json.dumps(final_report, indent=2))


if __name__ == "__main__":
    main()
