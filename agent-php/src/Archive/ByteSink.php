<?php

declare(strict_types=1);

namespace AutoWp\Agent\Archive;

interface ByteSink
{
    public function write(string $data): void;
}
