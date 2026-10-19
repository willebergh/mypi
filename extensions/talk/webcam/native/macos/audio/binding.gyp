{
  "targets": [{
    "target_name": "pitalk_audio",
    "sources": ["audio.cc"],
    "defines": ["NAPI_VERSION=8"],
    "xcode_settings": {
      "MACOSX_DEPLOYMENT_TARGET": "13.0",
      "CLANG_CXX_LANGUAGE_STANDARD": "c++17",
      "CLANG_CXX_LIBRARY": "libc++",
      "GCC_ENABLE_CPP_EXCEPTIONS": "YES",
      "GCC_OPTIMIZATION_LEVEL": "3",
      "OTHER_CPLUSPLUSFLAGS": ["-Wall", "-Wextra", "-Werror"]
    },
    "link_settings": {"libraries": [
      "-framework AudioToolbox", "-framework CoreAudio",
      "-framework CoreFoundation", "-framework Accelerate"
    ]}
  }]
}
