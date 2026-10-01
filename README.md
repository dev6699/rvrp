# RVRP — VR Video Player

A local video library and WebXR player for compatible VR headset and desktop browsers. The server
lists MP4 files from `videos/` (including subfolders) and streams them with byte-range support so
seeking works.

## Start the player

1. Install Node.js 20 or newer and OpenSSL.
2. Install dependencies with `npm install`.
3. Put MP4 files encoded with H.264 video and AAC audio into `videos/`.
4. Create a local HTTPS certificate with `npm run setup:cert`.
5. Install `certs/rootCA.pem` as a trusted CA certificate on the computer and VR headset. Keep
   `certs/rootCA-key.pem` private.
6. Start the server with `npm start`, then open the printed HTTPS LAN address in a WebXR-compatible
   browser.

To download the CA certificate, open `https://<PC-LAN-IP>:8443/ca.crt` on the headset or computer
after trusting the HTTPS certificate. This route serves only the public CA file, never the CA
private key.

The first run of `npm run setup:cert` creates a private local CA and signs a server certificate
containing the computer's current LAN IPv4 addresses. If address discovery is unavailable or the LAN
address changes, provide it explicitly, for example `CERT_HOSTS=192.168.1.42 npm run setup:cert`.
OpenSSL and generated credentials stay on the computer; the root CA certificate must be trusted by
each browser device for WebXR to run.

If the certificate is not installed yet, the server still starts over HTTP for desktop use. WebXR
needs a trusted HTTPS page. The player shows an explanation if VR cannot start.

## Configuration

- `VIDEO_DIR`: video directory. Defaults to the project's `videos/` folder.
- `PORT`: server port. Defaults to `8443`.
- `HOST`: listen address. Defaults to `0.0.0.0` so another device on the LAN can connect.
- `CERT_HOSTS`: optional comma-separated LAN addresses or hostnames to include in the certificate
  and print at startup, for example `192.168.1.42`.
- `HTTPS_CERT` and `HTTPS_KEY`: optional paths to a certificate and private key. Defaults to
  `certs/server.pem` and `certs/server-key.pem`.

The server exposes a read-only `GET /api/videos` library endpoint and `GET /videos/<id>` media
streams. It serves Three.js locally, so the player does not depend on an external script CDN. Video
files are only discovered by scanning the configured directory; symlinks are skipped and stream
paths are checked against the resolved directory.

## Recommended video encoding

For broad browser and headset decoding support, use MP4 with H.264/AVC video in 8-bit `yuv420p` and
AAC stereo audio. For 4K at 60 fps, start around 24 Mb/s video with a 30 Mb/s peak limit. This
player streams regular MP4 files rather than adaptive bitrate segments, so lower the bitrate or
resolution if the headset's Wi-Fi cannot sustain the stream. `+faststart` places the MP4 index near
the beginning of the file for quicker startup.

Convert a source video while keeping its existing dimensions and frame rate:

```sh
ffmpeg -i "input.mkv" -map 0:v:0 -map '0:a:0?' \
  -c:v libx264 -preset slow -profile:v high -level:v 5.2 -pix_fmt yuv420p \
  -b:v 24M -maxrate 30M -bufsize 60M \
  -c:a aac -b:a 192k -ac 2 -movflags +faststart "output.mp4"
```

For a lower-bandwidth encode, reduce `-b:v` and `-maxrate` (for example, `16M` and `20M`) or scale
the video to 2560×1440 with `-vf scale=2560:-2`.

## Use

1. Start the server with `npm start`, then open the printed HTTPS URL. Use `https://localhost:8443`
   on the server computer or `https://<PC-LAN-IP>:8443` on the headset. Choose a video from the
   library, or enter VR without selecting one and choose it from the floating collection.
2. Choose the projection and stereo layout in the player controls. Use **Flat** or **Cinema** for 2D
   video, or **180°** and **360°** for immersive video. Choose **Mono**, **Side by side**, or **Top
   / bottom** to match the video's layout. Playback defaults to cinema and Mono.
3. Select **Enter VR**. If you entered VR before choosing a video, point a controller at a library
   item and press the trigger to play it.
4. During playback, point at the video and press the trigger to show or hide the VR controls. Use
   the floating panel to play or pause, seek, change viewing settings, or choose another video.
   Select **Center** to place the video in front of your current view.
5. For a 2D screen, hold a controller grip and move your hand to reposition it. While gripping, push
   or pull the thumbstick to move the screen closer or farther. Press the right controller's **B**
   button to exit VR.

Outside VR, use the player controls to seek and change settings. In 180° or 360° mode, drag the
video to look around. Use the fullscreen control to fill the browser window. After exiting VR,
select **Enter VR** in the player header to return to the same video.

The player does not infer video formats or transcode unsupported codecs. Video decoding support
depends on the headset's browser and the video's codec profile and resolution.
