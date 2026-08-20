{{- define "vims-hms.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "vims-hms.fullname" -}}
{{- printf "%s-%s" .Release.Name (include "vims-hms.name" .) | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "vims-hms.labels" -}}
app.kubernetes.io/name: {{ include "vims-hms.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end -}}

{{/*
An unpinned image tag is refused rather than defaulted. docs/10 §6 requires a
signed, pinned tag, and `latest` makes a rollback meaningless — you cannot roll
back to a tag that has moved.
*/}}
{{- define "vims-hms.image" -}}
{{- $tag := .Values.image.tag -}}
{{- if not $tag -}}
{{- fail "image.tag is required: deploys must pin a signed tag (docs/10 §6), never `latest`" -}}
{{- end -}}
{{- printf "%s/%s:%s" .Values.image.registry .component $tag -}}
{{- end -}}
