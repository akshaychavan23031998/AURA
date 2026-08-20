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
    {
        "name": "calendar.events.create",
        "description": (
            "Creates one event on the authenticated user's primary Google Calendar. "
            "Requires an explicit summary, start, end, and IANA timezone."
        ),
        "category": "productivity",
        "inputSchema": {
            "type": "object",
            "additionalProperties": False,
            "properties": {
                "summary": {"type": "string", "minLength": 1, "maxLength": 200},
                "start": {"type": "string", "format": "date-time"},
                "end": {"type": "string", "format": "date-time"},
                "timezone": {"type": "string", "minLength": 1, "maxLength": 64},
                "location": {"type": "string", "minLength": 1, "maxLength": 500},
            },
            "required": ["summary", "start", "end", "timezone"],
        },
    },
    {
        "name": "calendar.events.update",
        "description": (
            "Updates allowlisted fields on one event in the authenticated user's "
            "primary Google Calendar. Requires an event ID and at least one change."
        ),
        "category": "productivity",
        "inputSchema": {
            "type": "object",
            "additionalProperties": False,
            "properties": {
                "eventId": {"type": "string", "minLength": 1, "maxLength": 1024},
                "summary": {"type": "string", "minLength": 1, "maxLength": 200},
                "start": {"type": "string", "format": "date-time"},
                "end": {"type": "string", "format": "date-time"},
                "timezone": {"type": "string", "minLength": 1, "maxLength": 64},
                "location": {"type": "string", "minLength": 1, "maxLength": 500},
            },
            "required": ["eventId"],
        },
    },
    {
        "name": "calendar.events.delete",
        "description": (
            "Permanently deletes one event from the authenticated user's primary "
            "Google Calendar by explicit event ID."
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
    {
        "name": "gmail.messages.list",
        "description": (
            "Lists bounded metadata for recent messages in the authenticated user's "
            "Gmail account, optionally filtered by plain search terms."
        ),
        "category": "communication",
        "inputSchema": {
            "type": "object",
            "additionalProperties": False,
            "properties": {
                "maxResults": {"type": "integer", "minimum": 1, "maximum": 20},
                "query": {"type": "string", "minLength": 1, "maxLength": 200},
            },
        },
    },
    {
        "name": "gmail.messages.get",
        "description": (
            "Gets bounded metadata and a snippet for one Gmail message by its "
            "explicit message identifier."
        ),
        "category": "communication",
        "inputSchema": {
            "type": "object",
            "additionalProperties": False,
            "properties": {
                "messageId": {"type": "string", "minLength": 1, "maxLength": 256}
            },
            "required": ["messageId"],
        },
    },
    {
        "name": "gmail.messages.send",
        "description": (
            "Sends one plain-text email to one explicit email address after the user "
            "confirms the action in the trusted approval interface."
        ),
        "category": "communication",
        "inputSchema": {
            "type": "object",
            "additionalProperties": False,
            "properties": {
                "to": {"type": "string", "format": "email", "maxLength": 320},
                "subject": {"type": "string", "minLength": 1, "maxLength": 200},
                "body": {"type": "string", "minLength": 1, "maxLength": 20000},
            },
            "required": ["to", "subject", "body"],
        },
    },
    {
        "name": "gmail.messages.reply",
        "description": (
            "Replies with plain text to one Gmail message identified by its exact "
            "message ID after the user confirms the action."
        ),
        "category": "communication",
        "inputSchema": {
            "type": "object",
            "additionalProperties": False,
            "properties": {
                "messageId": {"type": "string", "minLength": 1, "maxLength": 256},
                "body": {"type": "string", "minLength": 1, "maxLength": 20000},
            },
            "required": ["messageId", "body"],
        },
    },
    {
        "name": "contacts.people.list",
        "description": (
            "Lists a bounded set of the authenticated user's Google contacts."
        ),
        "category": "productivity",
        "inputSchema": {
            "type": "object",
            "additionalProperties": False,
            "properties": {
                "maxResults": {"type": "integer", "minimum": 1, "maximum": 25}
            },
        },
    },
    {
        "name": "contacts.people.get",
        "description": (
            "Gets one Google contact by an explicit People API resource name."
        ),
        "category": "productivity",
        "inputSchema": {
            "type": "object",
            "additionalProperties": False,
            "properties": {
                "resourceName": {
                    "type": "string",
                    "pattern": "^people/[A-Za-z0-9_-]+$",
                    "maxLength": 256,
                }
            },
            "required": ["resourceName"],
        },
    },
)
