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
)
