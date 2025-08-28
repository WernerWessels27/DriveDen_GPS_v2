
# DriveDen GPS v2 (Leaflet)

**What’s fixed**
- Correct GI auth (form-urlencoded)
- Search now includes GPS coordinate + ZA fallback
- Healthcheck `/healthz`
- Railway-ready (`0.0.0.0:${PORT}`)

## Env Vars (Railway)
- GI_BASE=https://api.golfintelligence.com
- GI_CLIENT_ID=YOUR_ID
- GI_API_TOKEN=YOUR_TOKEN
- (optional) PORT=8080

## Healthcheck
Set path to `/healthz` in Railway service settings.
