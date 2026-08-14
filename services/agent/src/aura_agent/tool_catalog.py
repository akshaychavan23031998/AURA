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
    {
        "name": "calendar.events.list",
        "description": (
            "Lists events from the authenticated user's primary Google Calendar "
            "within a bounded time window."
        ),
        "category": "productivity",
        "inputSchema": {
            "type": "object",
            "additionalProperties": False,
            "properties": {
                "timeMin": {"type": "string", "format": "date-time"},
                "timeMax": {"type": "string", "format": "date-time"},
                "maxResults": {"type": "integer", "minimum": 1, "maximum": 50},
            },
            "required": ["timeMin", "timeMax"],
        },
    },
    {
        "name": "calendar.events.get",
        "description": (
            "Gets one event from the authenticated user's primary Google Calendar."
        ),
        "category": "productivity",
        "inputSchema": {
            "type": "object",
            "additionalProperties": False,
            "properties": {
                "eventId": {"type": "string", "minLength": 1, "maxLength": 1024}
            },
            "required": ["eventId"],
        },
    },
)
