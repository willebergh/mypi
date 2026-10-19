{
  "targets": [{
    "target_name": "vc4m",
    "sources": ["producer.mm"],
    "defines": ["NAPI_VERSION=8"],
    "xcode_settings": {
      "MACOSX_DEPLOYMENT_TARGET": "13.0",
      "CLANG_CXX_LANGUAGE_STANDARD": "c++17",
      "CLANG_CXX_LIBRARY": "libc++",
      "CLANG_ENABLE_OBJC_ARC": "YES",
      "GCC_ENABLE_CPP_EXCEPTIONS": "YES",
      "OTHER_CFLAGS": ["-fobjc-exceptions", "-fobjc-arc-exceptions"],
      "OTHER_CPLUSPLUSFLAGS": ["-Wall", "-Wextra"]
    },
    "link_settings": {"libraries": [
      "-framework Foundation", "-framework Metal", "-framework IOSurface",
      "-framework CoreVideo", "-framework CoreMedia", "-framework CoreMediaIO"
    ]}
  }]
}
