FROM ubuntu:20.04

# Install SSH server and zmodem
RUN apt-get update && apt-get install -y openssh-server lrzsz && \
    mkdir /var/run/sshd && \
    echo 'root:root' | chpasswd && \
    sed -i 's/#PermitRootLogin prohibit-password/PermitRootLogin yes/' /etc/ssh/sshd_config && \
    sed -i 's/#PasswordAuthentication yes/PasswordAuthentication yes/' /etc/ssh/sshd_config

# Create user zxd
RUN useradd -m -s /bin/bash zxd && echo 'zxd:zxd' | chpasswd

# Expose port 22, but we'll map to 23355
EXPOSE 22

CMD ["/usr/sbin/sshd", "-D"]