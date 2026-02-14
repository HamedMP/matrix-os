---
name: weather
description: Look up current weather for any location
triggers:
  - weather
  - forecast
  - temperature
  - rain
---

# Weather Lookup

When the user asks about weather:

1. Determine the location (ask if not specified, use user's timezone as hint)
2. Use WebSearch to find current weather conditions
3. Extract: temperature, conditions, humidity, wind speed
4. Format based on channel:
   - Web shell: detailed with icon/emoji, forecast if available
   - Messaging: concise one-liner, e.g. "Stockholm: 3C, cloudy, light wind"
5. If they ask for forecast, include next 3-5 days
6. Use the user's preferred units (check user.md for locale hints, default to Celsius)
