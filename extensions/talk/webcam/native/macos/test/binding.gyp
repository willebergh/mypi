{
  "targets": [{
    "target_name": "fixture",
    "sources": ["fixture.mm"],
    "defines": ["NAPI_VERSION=8"],
    "xcode_settings": {
      "MACOSX_DEPLOYMENT_TARGET": "12.0",
      "CLANG_CXX_LANGUAGE_STANDARD": "c++17",
      "CLANG_ENABLE_OBJC_ARC": "YES"
    },
    "link_settings": {
      "libraries": ["-framework Foundation", "-framework IOSurface"]
    }
  }]
}
