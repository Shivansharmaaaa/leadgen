"""
Render conversations exactly the way Ollama renders them at inference.

The fine-tuned model is served through models/leadgen-llama3.2.Modelfile, so
the training text has to match that template token for token: tool schemas at
the top of the system block, the system prompt and per-turn context joined
the way the Ollama provider joins them, tool calls in Llama's JSON form, and
tool results under the `ipython` role. A model trained on a different layout
learns a format it never sees in production.
"""

from __future__ import annotations

import json
from typing import Any

BOS = "<|begin_of_text|>"
EOT = "<|eot_id|>"

TOOL_PREAMBLE = (
    'You have access to the following functions. To call one, respond with JSON in the '
    'format {"name": function name, "parameters": dictionary of argument name and its '
    'value}. Do not use variables.\n\n'
)


def header(role: str) -> str:
    return f"<|start_header_id|>{role}<|end_header_id|>"


def go_json(value: Any) -> str:
    """Compact JSON in the field order the caller built, as Go writes structs."""
    return json.dumps(value, separators=(",", ":"), ensure_ascii=False, sort_keys=False)


def tool_for_template(tool: dict) -> dict:
    """Mirror Ollama's api.Tool field order; unknown keys are dropped like Go does."""
    fn = tool["function"]
    params = fn.get("parameters", {})
    props = {}
    for key in sorted(params.get("properties", {})):
        spec = params["properties"][key]
        props[key] = {k: spec[k] for k in ("type", "items", "description", "enum") if k in spec}
    rendered_params = {"type": params.get("type", "object")}
    if params.get("required"):
        rendered_params["required"] = params["required"]
    rendered_params["properties"] = props
    return {
        "type": "function",
        "function": {"name": fn["name"], "description": fn.get("description", ""), "parameters": rendered_params},
    }


def tool_call_text(name: str, arguments: dict) -> str:
    args = json.dumps(arguments, separators=(",", ":"), ensure_ascii=False, sort_keys=True)
    return f'{{"name": "{name}", "parameters": {args}}}'


def render_system(system: str, context: str | None, tools: list[dict]) -> str:
    out = header("system") + "\n\nCutting Knowledge Date: December 2023\n\n"
    if tools:
        out += TOOL_PREAMBLE
        for tool in tools:
            out += go_json(tool_for_template(tool)) + "\n"
        out += "\n"
    # Same join as OllamaProvider.systemContent().
    out += (f"{system}\n\n{context}" if context else system) + EOT
    return out


def collate(messages: list[dict]) -> list[dict]:
    """Ollama merges consecutive messages of the same role before templating."""
    merged: list[dict] = []
    for m in messages:
        if merged and merged[-1]["role"] == m["role"] and m["role"] in ("user", "tool"):
            merged[-1] = {**merged[-1], "content": merged[-1]["content"] + "\n\n" + m["content"]}
        else:
            merged.append(dict(m))
    return merged


def render_message(m: dict) -> str:
    role = m["role"]
    if role == "user":
        return header("user") + "\n\n" + m["content"] + EOT
    if role == "tool":
        return header("ipython") + "\n\n" + m["content"] + EOT
    if role == "assistant":
        if m.get("tool_calls"):
            calls = "".join("\n" + tool_call_text(c["name"], c["arguments"]) for c in m["tool_calls"])
            return header("assistant") + "\n" + calls + EOT
        return header("assistant") + "\n\n" + m["content"] + EOT
    raise ValueError(f"unknown role {role}")


def render_prompt(system: str, context: str | None, tools: list[dict], messages: list[dict]) -> str:
    """Everything up to and including the assistant header the model writes after."""
    text = BOS + render_system(system, context, tools)
    for m in collate(messages):
        text += render_message(m)
    return text + header("assistant") + "\n\n"


def render_target(target: dict) -> str:
    """What the model should write next: one reply or one set of tool calls."""
    if target.get("tool_calls"):
        return "\n".join(tool_call_text(c["name"], c["arguments"]) for c in target["tool_calls"]) + EOT
    return target["content"] + EOT
