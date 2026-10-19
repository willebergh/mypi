{
  "targets": [
    {
      "target_name": "bridge",
      "sources": ["bridge.mm"],
      "defines": ["NAPI_VERSION=8"],
      "conditions": [
        ["OS=='mac'", {
          "xcode_settings": {
            "MACOSX_DEPLOYMENT_TARGET": "12.0",
            "CLANG_CXX_LANGUAGE_STANDARD": "c++17",
            "CLANG_CXX_LIBRARY": "libc++",
            "CLANG_ENABLE_OBJC_ARC": "YES",
            "GCC_ENABLE_CPP_EXCEPTIONS": "YES",
            "OTHER_CFLAGS": ["-fobjc-exceptions", "-fobjc-arc-exceptions"],
            "OTHER_CPLUSPLUSFLAGS": ["-Wall", "-Wextra"]
          },
          "link_settings": {
            "libraries": [
              "-framework Foundation",
              "-framework Metal",
              "-framework IOSurface"
            ]
          }
        }, {
          "type": "none"
        }]
      ]
    }
  ]
}
