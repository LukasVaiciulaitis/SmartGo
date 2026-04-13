package com.example.smartgoprototype.ui.theme

import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color

private val DarkColorScheme = darkColorScheme(
    primary = Green,
    onPrimary = Color(0xFF000000),
    primaryContainer = GreenDark,
    onPrimaryContainer = Green,
    secondary = Green,
    onSecondary = Color(0xFF000000),
    secondaryContainer = GreenDark,
    onSecondaryContainer = Green,
    background = Color(0xFF000000),
    onBackground = Color(0xFFFFFFFF),
    surface = Color(0xFF18181B),
    onSurface = Color(0xFFE0E0E0),
    surfaceVariant = Color(0xFF1C1C1C),
    onSurfaceVariant = Color(0xFFBDBDBD),
    outline = Color(0xFF424242)
)

@Composable
fun SmartGoPrototypeTheme(
    content: @Composable () -> Unit
) {
    MaterialTheme(
        colorScheme = DarkColorScheme,
        typography = Typography,
        content = content
    )
}
