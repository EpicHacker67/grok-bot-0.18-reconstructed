FROM golang:1.25.6-bookworm AS build
WORKDIR /src
COPY streamer/go.mod streamer/go.sum ./
RUN go mod download
COPY streamer/ ./
RUN CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath -o /desktop-stream .

FROM public.ecr.aws/k0i0n2g5/cursorenvironments/universal@sha256:289490f863d51a698c900839943311ba30e850efea0d6911edf62e7c07b50fe3
USER root
RUN apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends \
    xserver-xorg-core xclip mesa-utils libglvnd0 libegl1 libglx0 libgles2 pulseaudio pulseaudio-utils libasound2-plugins \
    && rm -rf /var/lib/apt/lists/*
COPY --from=build /desktop-stream /usr/local/bin/mengel-desktop-stream
COPY xorg.conf /etc/X11/mengel-xorg.conf
COPY patch-desktop.py /tmp/mengel-patch-desktop.py
RUN python3 /tmp/mengel-patch-desktop.py && rm /tmp/mengel-patch-desktop.py
COPY audio-setup.sh /usr/local/lib/mengel/audio-setup.sh
COPY start-mengel /usr/local/bin/start-mengel
RUN chmod +x /usr/local/bin/start-mengel
ENV SCREEN_WIDTH=1920 SCREEN_HEIGHT=1080
ENTRYPOINT ["/usr/local/bin/start-mengel"]
