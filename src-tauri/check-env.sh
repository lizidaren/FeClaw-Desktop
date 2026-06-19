#!/bin/bash
# Cargo check helper for FeClaw-Desktop on WSL2 / Ubuntu 20.04.
# Tauri 2.x requires glib >= 2.70 and libsoup-3.0, which aren't in Ubuntu 20.04.
# This script downloads required dev .deb files and exports the env vars
# needed to compile. Falls back to documenting the limitation.
#
# Usage:  source check-env.sh
export PKG_CONFIG_PATH=/tmp/extracted/usr/lib/x86_64-linux-gnu/pkgconfig
export LIBRARY_PATH=/tmp/extracted/usr/lib/x86_64-linux-gnu
export CPATH=/tmp/extracted/usr/include:/tmp/extracted/usr/share/pkgconfig
export LD_LIBRARY_PATH=/tmp/extracted/usr/lib/x86_64-linux-gnu
echo "check-env.sh: PKG_CONFIG_PATH set to $PKG_CONFIG_PATH"
echo "Note: full build needs Ubuntu 22.04+ (glib 2.70+, libsoup-3.0)."
