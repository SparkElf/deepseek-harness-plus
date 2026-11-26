# docker buildx bake definition for the workspace image.
#
# This is an alternative entry to scripts/build-workspace-final.sh, not a replacement: the shell
# entry chains the three layers by image ID and remains the release path. Bake exists so CI and a
# second host can build the same three targets, share a registry cache, and select a platform
# without re-implementing the build arguments.
#
# Run from this directory:
#
#   docker buildx bake --print                       # resolve targets, build nothing
#   docker buildx bake base                          # one target
#   docker buildx bake                               # base -> plus -> runtime (group default)
#
# Defaults name the candidate repository. Nothing is pushed and no registry cache is used unless
# REGISTRY_CACHE is set explicitly:
#
#   REGISTRY_CACHE=registry.example.com/dataops/workspace-cache docker buildx bake
#
# A registry cache writes cache metadata only; it does not push images. Pushing is a separate,
# explicit output: `docker buildx bake --push` with a registry-qualified IMAGE_REPOSITORY. The
# candidate binding in acceptance/release-binding.json is written by the shell entry, not by bake,
# because bake has no post-build hook.

variable "IMAGE_REPOSITORY" {
  default = "dataops-ai-workspace-candidate"
}

variable "DSH_PLUS_VERSION" {
  default = "0.2.9-alpha.106"
}

variable "DSH_SOURCE_REVISION" {
  default = "4b399c39a6d1479cd84ca591b4d7c88e24d38a96"
}

variable "DSH_SOURCE_REGISTRY" {
  default = "https://registry.npmmirror.com"
}

variable "DSH_PLUS_INSTALL_REGISTRY" {
  default = "https://mirrors.cloud.tencent.com/npm"
}

variable "DATAOPS_PROFILE_DEFAULTS" {
  default = "cordis.patch.yml"
}

variable "RUNTIME_PRUNE" {
  default = "0"
}

variable "PLATFORMS" {
  default = "linux/amd64"
}

variable "REGISTRY_CACHE" {
  default = ""
}

variable "HTTP_PROXY" {
  default = ""
}

variable "HTTPS_PROXY" {
  default = ""
}

variable "NO_PROXY" {
  default = "localhost,127.0.0.1,registry.npmmirror.com"
}

group "default" {
  targets = ["runtime"]
}

target "base" {
  context    = "./context"
  dockerfile = "Dockerfile"
  target     = "workspace-base"
  tags       = ["${IMAGE_REPOSITORY}:base-py312"]
  platforms  = [PLATFORMS]
  contexts = {
    "workspace-web-gateway-protocol" = "./context/workspace-web-gateway-protocol"
  }
  cache-from = REGISTRY_CACHE != "" ? ["type=registry,ref=${REGISTRY_CACHE}/base"] : []
  cache-to   = REGISTRY_CACHE != "" ? ["type=registry,ref=${REGISTRY_CACHE}/base,mode=max"] : []
}

target "source-build" {
  context    = "./context"
  dockerfile = "Dockerfile.plus-cli-src"
  target     = "source-build"
  # Intermediate stage: patches, official build and marker. Kept as a first-class target so a
  # source-only rebuild can be built, inspected and cached without producing the final layer.
  depends_on = ["base"]
  tags       = ["${IMAGE_REPOSITORY}:source-build-${DSH_PLUS_VERSION}"]
  platforms  = [PLATFORMS]
  contexts = {
    "workspace-web-gateway-protocol" = "./context/workspace-web-gateway-protocol"
  }
  args = {
    BASE_IMAGE                = "${IMAGE_REPOSITORY}:base-py312"
    DSH_PLUS_VERSION          = DSH_PLUS_VERSION
    DSH_SOURCE_REVISION       = DSH_SOURCE_REVISION
    DSH_SOURCE_REGISTRY       = DSH_SOURCE_REGISTRY
    DSH_PLUS_INSTALL_REGISTRY = DSH_PLUS_INSTALL_REGISTRY
    DATAOPS_PROFILE_DEFAULTS  = DATAOPS_PROFILE_DEFAULTS
    RUNTIME_PRUNE             = "0"
    HTTP_PROXY                = HTTP_PROXY
    HTTPS_PROXY               = HTTPS_PROXY
    NO_PROXY                  = NO_PROXY
  }
  cache-from = REGISTRY_CACHE != "" ? ["type=registry,ref=${REGISTRY_CACHE}/plus-source"] : []
  cache-to   = REGISTRY_CACHE != "" ? ["type=registry,ref=${REGISTRY_CACHE}/plus-source,mode=max"] : []
}

target "plus" {
  context    = "./context"
  dockerfile = "Dockerfile.plus-cli-src"
  # `depends_on` makes bake finish and load the base tag before this target resolves BASE_IMAGE.
  depends_on = ["base"]
  tags = [
    "${IMAGE_REPOSITORY}:plus-cli-py312-${DSH_PLUS_VERSION}",
    "${IMAGE_REPOSITORY}:runtime-files",
  ]
  platforms = [PLATFORMS]
  contexts = {
    "workspace-web-gateway-protocol" = "./context/workspace-web-gateway-protocol"
  }
  args = {
    BASE_IMAGE                = "${IMAGE_REPOSITORY}:base-py312"
    DSH_PLUS_VERSION          = DSH_PLUS_VERSION
    DSH_SOURCE_REVISION       = DSH_SOURCE_REVISION
    DSH_SOURCE_REGISTRY       = DSH_SOURCE_REGISTRY
    DSH_PLUS_INSTALL_REGISTRY = DSH_PLUS_INSTALL_REGISTRY
    DATAOPS_PROFILE_DEFAULTS  = DATAOPS_PROFILE_DEFAULTS
    RUNTIME_PRUNE             = RUNTIME_PRUNE
    HTTP_PROXY                = HTTP_PROXY
    HTTPS_PROXY               = HTTPS_PROXY
    NO_PROXY                  = NO_PROXY
  }
  cache-from = REGISTRY_CACHE != "" ? ["type=registry,ref=${REGISTRY_CACHE}/plus"] : []
  cache-to   = REGISTRY_CACHE != "" ? ["type=registry,ref=${REGISTRY_CACHE}/plus,mode=max"] : []
}

target "runtime" {
  context    = "./context"
  dockerfile = "Dockerfile.runtime-cli"
  depends_on = ["plus"]
  tags       = ["${IMAGE_REPOSITORY}:final-bake"]
  platforms  = [PLATFORMS]
  args = {
    DSH_LAYER_IMAGE              = "${IMAGE_REPOSITORY}:plus-cli-py312-${DSH_PLUS_VERSION}"
    DATAOPS_RUNTIME_FILES_IMAGE  = "${IMAGE_REPOSITORY}:runtime-files"
    DSH_PLUS_VERSION             = DSH_PLUS_VERSION
    DATAOPS_PROFILE_DEFAULTS     = DATAOPS_PROFILE_DEFAULTS
  }
  cache-from = REGISTRY_CACHE != "" ? ["type=registry,ref=${REGISTRY_CACHE}/runtime"] : []
  cache-to   = REGISTRY_CACHE != "" ? ["type=registry,ref=${REGISTRY_CACHE}/runtime,mode=max"] : []
}
