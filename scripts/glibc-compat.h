/*
 * Force-included into native modules (node-pty) when building the x64
 * AppImage (see "dist:build" in package.json).
 *
 * glibc 2.42 gave cfsetispeed/cfsetospeed new symbol versions. Building on a
 * newer distro would make pty.node require GLIBC_2.42 and fail to load on
 * older ones (e.g. Ubuntu 22.04/24.04). Bind them to the original x86-64
 * versions, which every glibc still exports. scripts/check-glibc.js verifies
 * the result after the build.
 */
/* __gnu_linux__ is predefined by the compiler; __GLIBC__ would only be known
 * after <features.h>, which hasn't been included when this file is forced in. */
#if defined(__x86_64__) && defined(__gnu_linux__)
__asm__(".symver cfsetispeed,cfsetispeed@GLIBC_2.2.5");
__asm__(".symver cfsetospeed,cfsetospeed@GLIBC_2.2.5");
#endif
