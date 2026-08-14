from typing import Final

AGENT_TOOL_CATALOG: Final = (
    {
        "name": "system.echo",
        "description": "Returns supplied text unchanged.",
        "category": "system",
        "inputSchema": {
            "type": "object",
            "additionalProperties": False,
            "properties": {
                "message": {"type": "string", "minLength": 1, "maxLength": 4096}
            },
            "required": ["message"],
        },
    },
    {
        "name": "utility.calculator",
        "description": (
            "Evaluates arithmetic with numbers, parentheses, addition, subtraction, "
            "multiplication, and division."
        ),
        "category": "utility",
        "inputSchema": {
            "type": "object",
            "additionalProperties": False,
            "properties": {
                "expression": {"type": "string", "minLength": 1, "maxLength": 256}
            },
            "required": ["expression"],
        },
    },
    {
        "name": "utility.datetime",
        "description": (
            "Returns the current date and time for an explicit IANA timezone."
        ),
        "category": "utility",
        "inputSchema": {
            "type": "object",
            "additionalProperties": False,
            "properties": {
                "operation": {"enum": ["current_time", "current_date"]},
                "timezone": {"type": "string", "minLength": 1, "maxLength": 64},
            },
            "required": ["operation", "timezone"],
        },
    },
)
