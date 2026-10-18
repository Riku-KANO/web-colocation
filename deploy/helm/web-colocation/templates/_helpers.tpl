{{/* Chart name. */}}
{{- define "web-colocation.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/* Fully qualified app name. */}}
{{- define "web-colocation.fullname" -}}
{{- if .Values.fullnameOverride }}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- $name := default .Chart.Name .Values.nameOverride }}
{{- if contains $name .Release.Name }}
{{- .Release.Name | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" }}
{{- end }}
{{- end }}
{{- end }}

{{- define "web-colocation.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{- end }}

{{- define "web-colocation.selectorLabels" -}}
app.kubernetes.io/name: {{ include "web-colocation.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{- define "web-colocation.labels" -}}
helm.sh/chart: {{ include "web-colocation.chart" . }}
{{ include "web-colocation.selectorLabels" . }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}

{{- define "web-colocation.serviceAccountName" -}}
{{- if .Values.serviceAccount.create }}
{{- default (include "web-colocation.fullname" .) .Values.serviceAccount.name }}
{{- else }}
{{- default "default" .Values.serviceAccount.name }}
{{- end }}
{{- end }}

{{- define "web-colocation.image" -}}
{{- printf "%s:%s" .Values.image.repository (default .Chart.AppVersion .Values.image.tag) }}
{{- end }}

{{- define "web-colocation.turnSecretName" -}}
{{- default (printf "%s-turn" (include "web-colocation.fullname" .)) .Values.turn.existingSecret }}
{{- end }}

{{- define "web-colocation.hasTurnSecret" -}}
{{- if or .Values.turn.existingSecret .Values.turn.secret }}true{{ end }}
{{- end }}

{{- define "web-colocation.oauth2SecretName" -}}
{{- default (printf "%s-oauth2-proxy" (include "web-colocation.fullname" .)) .Values.oauth2Proxy.existingSecret }}
{{- end }}

{{/* Cookie secret: explicit value, else the one already stored in the cluster, else a new one. */}}
{{- define "web-colocation.cookieSecret" -}}
{{- if .Values.oauth2Proxy.cookieSecret }}
{{- .Values.oauth2Proxy.cookieSecret }}
{{- else }}
{{- $existing := lookup "v1" "Secret" .Release.Namespace (include "web-colocation.oauth2SecretName" .) }}
{{- if and $existing $existing.data (index $existing.data "cookie-secret") }}
{{- index $existing.data "cookie-secret" | b64dec }}
{{- else }}
{{- randAlphaNum 32 }}
{{- end }}
{{- end }}
{{- end }}

{{/* Public host used for the OAuth callback when redirectUrl is not set. */}}
{{- define "web-colocation.publicHost" -}}
{{- if and .Values.ingress.enabled .Values.ingress.hosts }}
{{- (first .Values.ingress.hosts).host }}
{{- else if and .Values.httpRoute.enabled .Values.httpRoute.hostnames }}
{{- first .Values.httpRoute.hostnames }}
{{- end }}
{{- end }}

{{/*
Application config: the user's `config` plus settings that follow from this deployment
(storage on the volume, assets mount, auth mode when oauth2-proxy is enabled, TURN secret env).
*/}}
{{- define "web-colocation.appConfig" -}}
{{- $cfg := deepCopy (default dict .Values.config) }}
{{- $storage := dict "driver" (ternary "file" "memory" .Values.persistence.enabled) "dir" "/data" }}
{{- $_ := set $cfg "storage" $storage }}
{{- if or .Values.assets.existingClaim .Values.assets.configMap }}
{{- $assets := deepCopy (default dict (get $cfg "assets")) }}
{{- $_ := set $assets "dir" "/assets" }}
{{- $_ := set $cfg "assets" $assets }}
{{- end }}
{{- if .Values.oauth2Proxy.enabled }}
{{- $auth := deepCopy (default dict (get $cfg "auth")) }}
{{- $_ := set $auth "mode" "trusted-headers" }}
{{- $_ := set $auth "preset" "oauth2-proxy" }}
{{- $_ := unset $auth "headers" }}
{{- $_ := set $cfg "auth" $auth }}
{{- end }}
{{- $server := deepCopy (default dict (get $cfg "server")) }}
{{- $host := include "web-colocation.publicHost" . }}
{{- if and $host (not (hasKey $server "publicUrl")) }}
{{- $_ := set $server "publicUrl" (printf "https://%s" $host) }}
{{- end }}
{{- $_ := set $cfg "server" $server }}
{{- $turn := dig "voice" "turn" nil $cfg }}
{{- if and $turn (include "web-colocation.hasTurnSecret" .) }}
{{- $_ := set $turn "secretEnv" "TURN_SECRET" }}
{{- end }}
{{- toYaml $cfg }}
{{- end }}
