{{/*
Chart name.
*/}}
{{- define "tape.name" -}}
{{- .Chart.Name | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{/*
Fully qualified release-scoped name. If the release name already contains
the chart name, don't repeat it.
*/}}
{{- define "tape.fullname" -}}
{{- if contains .Chart.Name .Release.Name -}}
{{- .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" .Release.Name .Chart.Name | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}

{{/*
Common labels applied to every object.
*/}}
{{- define "tape.labels" -}}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | trunc 63 | trimSuffix "-" }}
app.kubernetes.io/name: {{ include "tape.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end -}}

{{/*
Selector labels — the immutable subset shared by a Deployment's selector,
its pod template, and the matching Service. Components add
`app.kubernetes.io/component: <feed|monitor|entry>` alongside these.
*/}}
{{- define "tape.selectorLabels" -}}
app.kubernetes.io/name: {{ include "tape.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}
