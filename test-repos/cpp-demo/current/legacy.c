int retry_delay(int attempts) {
    if (attempts > 5) return 60;
    return 10;
}
