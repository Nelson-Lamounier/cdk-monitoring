options "general" {
  update_check = false
  telemetry    = false
}

options "database" {
  # Cache query results for 5 minutes to reduce API calls
  cache     = true
  cache_ttl = 300

  # Connection pool settings
  port = 9193
}
