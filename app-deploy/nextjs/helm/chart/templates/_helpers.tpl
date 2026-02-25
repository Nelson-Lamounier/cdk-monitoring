{{/*
Common labels for all resources
*/}}
{{- define "nextjs-topology.labels" -}}
app: nextjs
app.kubernetes.io/name: nextjs
app.kubernetes.io/part-of: nextjs
app.kubernetes.io/managed-by: helm
helm.sh/chart: {{ .Chart.Name }}-{{ .Chart.Version }}
{{- end }}

{{/*
Selector labels (must match the existing Deployment selector)
*/}}
{{- define "nextjs-topology.selectorLabels" -}}
app: nextjs
{{- end }}
