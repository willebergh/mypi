{
  "targets": [{
    "target_name": "camera_manager",
    "sources": ["manager.mm"],
    "defines": ["NAPI_VERSION=8"],
    "xcode_settings": {
      "MACOSX_DEPLOYMENT_TARGET": "12.3",
      "CLANG_CXX_LANGUAGE_STANDARD": "c++17",
      "CLANG_ENABLE_OBJC_ARC": "YES",
      "GCC_ENABLE_CPP_EXCEPTIONS": "YES"
    },
    "link_settings": { "libraries": ["-framework Foundation", "-framework SystemExtensions", "-framework Security"] }
  }]
}
