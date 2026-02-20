options "general" {
  update_check = false
  telemetry    = false
}

options "database" {
  cache = true

  # Connection pool settings
  port = 9193
}
