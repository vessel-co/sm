 { stdenv, lib
, fetchurl
, autoPatchelfHook
}:

stdenv.mkDerivation rec {
  pname = "sm";
  version = "0.0.2";

  src = fetchurl {
    url = "https://github.com/nebez/sm/releases/download/${version}/sm-mac-arm-${version}";
    sha256 = "1syh8qihsdgg0nn3yawp0rn36cxswvz4fhh3lrqcayhh3gp18kv2";
  };

  nativeBuildInputs = [
    autoPatchelfHook
  ];

  buildInputs = [ ];

  sourceRoot = ".";

  installPhase = ''
    install -m755 -D sm-mac-arm-${version} $out/bin/sm
  '';

  meta = with lib; {
    platforms = platforms.darwin;
  };
}
