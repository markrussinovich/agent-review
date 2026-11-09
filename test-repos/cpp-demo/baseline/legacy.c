int retry_delay(int attempts) {
    if (attempts > 3) return 30;
    return 10;
}
