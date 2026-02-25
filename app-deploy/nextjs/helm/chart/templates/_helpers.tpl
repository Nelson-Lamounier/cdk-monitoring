{{/*
Common labels for all resources
*/}}
{{- define "nextjs.labels" -}}
app: nextjs
app.kubernetes.io/name: nextjs
app.kubernetes.io/part-of: nextjs
app.kubernetes.io/managed-by: helm
helm.sh/chart: {{ .Chart.Name }}-{{ .Chart.Version }}
{{- end }}

{{/*
Selector labels (must be consistent across Deployment + Service + HPA)
*/}}
{{- define "nextjs.selectorLabels" -}}
app: nextjs
{{- end }}

{{/*
Full component labels (includes component designation)
*/}}
{{- define "nextjs.componentLabels" -}}
{{ include "nextjs.labels" . }}
app.kubernetes.io/component: web
{{- end }}
