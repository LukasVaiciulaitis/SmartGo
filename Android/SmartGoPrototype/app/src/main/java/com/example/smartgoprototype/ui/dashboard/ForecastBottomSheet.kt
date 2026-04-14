package com.example.smartgoprototype.ui.dashboard

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.drawText
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.rememberTextMeasurer
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.example.smartgoprototype.domain.model.ForecastStatus
import com.example.smartgoprototype.domain.model.Route
import java.time.DayOfWeek
import java.time.LocalDate

internal val CHART_COLORS = listOf(
    Color(0xFF0FA253), // Green
    Color(0xFFFFC107), // Amber
    Color(0xFF29B6F6), // Light Blue
    Color(0xFFFF7043), // Deep Orange
    Color(0xFFAB47BC)  // Purple
)

private val DAY_CODE_TO_LABEL = mapOf(
    "MON" to "M", "TUE" to "Tu", "WED" to "W", "THU" to "Th",
    "FRI" to "F", "SAT" to "Sa", "SUN" to "Su"
)

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ForecastSheet(
    routes: List<Route>,
    modifier: Modifier = Modifier
) {
    var showTotal by remember { mutableStateOf(false) }
    val chartRoutes = remember(routes) {
        routes.filter { it.forecastStatus == ForecastStatus.ACTIVE && it.userActive }.take(5)
    }
    val orderedDays = remember { orderedDaysFromToday() }

    Column(
        modifier = modifier
            .fillMaxWidth()
            .padding(horizontal = 16.dp)
            .padding(bottom = 12.dp)
    ) {
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.End,
            verticalAlignment = Alignment.CenterVertically
        ) {
            SingleChoiceSegmentedButtonRow(modifier = Modifier.height(32.dp)) {
                SegmentedButton(
                    selected = !showTotal,
                    onClick = { showTotal = false },
                    shape = SegmentedButtonDefaults.itemShape(index = 0, count = 2),
                    label = { Text("Delay", style = MaterialTheme.typography.labelSmall) }
                )
                SegmentedButton(
                    selected = showTotal,
                    onClick = { showTotal = true },
                    shape = SegmentedButtonDefaults.itemShape(index = 1, count = 2),
                    label = { Text("Duration", style = MaterialTheme.typography.labelSmall) }
                )
            }
        }

        Spacer(Modifier.height(6.dp))

        if (chartRoutes.isEmpty()) {
            Box(
                modifier = Modifier
                    .fillMaxWidth()
                    .height(90.dp),
                contentAlignment = Alignment.Center
            ) {
                Text(
                    text = "No forecast data available yet",
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant
                )
            }
        } else {
            ForecastLineChart(
                chartRoutes = chartRoutes,
                showTotal = showTotal,
                orderedDays = orderedDays,
                modifier = Modifier.fillMaxWidth()
            )
            Spacer(Modifier.height(8.dp))
            ForecastLegend(chartRoutes = chartRoutes)
            Spacer(Modifier.height(4.dp))
            Text(
                text = "Showing top 5 active routes \u2022 Hold & drag to reorder",
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant
            )
        }
    }
}

@Composable
private fun ForecastLineChart(
    chartRoutes: List<Route>,
    showTotal: Boolean,
    orderedDays: List<String>,
    modifier: Modifier = Modifier
) {
    val series: List<List<Float?>> = chartRoutes.map { route ->
        orderedDays.map { day ->
            val fd = route.forecast?.days?.get(day) ?: return@map null
            if (showTotal) {
                ((route.staticDuration ?: 0) + fd.recommendation.extraBufferMins).toFloat()
            } else {
                fd.recommendation.extraBufferMins.toFloat()
            }
        }
    }

    val allValues = series.flatten().filterNotNull()
    if (allValues.isEmpty()) return

    val rawMin = allValues.minOrNull()!!
    val rawMax = allValues.maxOrNull()!!
    val yMin = if (!showTotal) minOf(rawMin - 2f, 0f) else (rawMin - 5f).coerceAtLeast(0f)
    val yMax = rawMax + 5f
    val yRange = (yMax - yMin).coerceAtLeast(1f)

    val gridColor = Color(0xFF2A2A2A)
    val axisColor = Color(0xFF757575)
    val zeroLineColor = Color(0xFF3A3A3A)
    val axisLabelStyle = TextStyle(fontSize = 9.sp, color = axisColor)
    val gridLineCount = 4
    val textMeasurer = rememberTextMeasurer()
    val surfaceColor = MaterialTheme.colorScheme.surface

    Canvas(modifier = modifier.height(130.dp)) {
        val labelAreaLeft = 34.dp.toPx()
        val labelAreaBottom = 20.dp.toPx()
        val chartTop = 6.dp.toPx()
        val chartLeft = labelAreaLeft
        val chartBottom = size.height - labelAreaBottom
        val chartW = size.width - chartLeft
        val chartH = chartBottom - chartTop
        val xStep = if (orderedDays.size > 1) chartW / (orderedDays.size - 1).toFloat() else 0f

        // Horizontal grid lines + y-axis labels
        for (i in 0..gridLineCount) {
            val fraction = i.toFloat() / gridLineCount
            val y = chartTop + chartH * (1f - fraction)
            val value = yMin + yRange * fraction

            drawLine(
                color = gridColor,
                start = Offset(chartLeft, y),
                end = Offset(size.width, y),
                strokeWidth = 1.dp.toPx()
            )

            val label = value.toInt().toString()
            val measured = textMeasurer.measure(label, axisLabelStyle)
            drawText(
                textMeasurer = textMeasurer,
                text = label,
                topLeft = Offset(
                    x = chartLeft - measured.size.width - 4.dp.toPx(),
                    y = y - measured.size.height / 2f
                ),
                style = axisLabelStyle
            )
        }

        // Zero line in delta mode when range spans negative
        if (!showTotal && yMin < 0f && yMax > 0f) {
            val zeroY = chartTop + chartH * (1f - (0f - yMin) / yRange)
            drawLine(
                color = zeroLineColor,
                start = Offset(chartLeft, zeroY),
                end = Offset(size.width, zeroY),
                strokeWidth = 1.5.dp.toPx()
            )
        }

        // X-axis labels
        orderedDays.forEachIndexed { index, day ->
            val x = chartLeft + index * xStep
            val label = DAY_CODE_TO_LABEL[day] ?: day.take(1)
            val measured = textMeasurer.measure(label, axisLabelStyle)
            drawText(
                textMeasurer = textMeasurer,
                text = label,
                topLeft = Offset(
                    x = x - measured.size.width / 2f,
                    y = chartBottom + 4.dp.toPx()
                ),
                style = axisLabelStyle
            )
        }

        // Lines and dots per route
        series.forEachIndexed { routeIndex, points ->
            val color = CHART_COLORS[routeIndex]
            val path = Path()
            var pathStarted = false

            points.forEachIndexed { dayIndex, value ->
                if (value != null) {
                    val x = chartLeft + dayIndex * xStep
                    val y = chartTop + chartH * (1f - (value - yMin) / yRange)
                    if (!pathStarted) { path.moveTo(x, y); pathStarted = true } else path.lineTo(x, y)
                }
            }

            drawPath(
                path = path,
                color = color,
                style = Stroke(
                    width = 2.dp.toPx(),
                    cap = StrokeCap.Round,
                    join = StrokeJoin.Round
                )
            )

            // Dots — filled with route color, hollow center in surface color
            points.forEachIndexed { dayIndex, value ->
                if (value != null) {
                    val x = chartLeft + dayIndex * xStep
                    val y = chartTop + chartH * (1f - (value - yMin) / yRange)
                    drawCircle(color = color, radius = 4.dp.toPx(), center = Offset(x, y))
                    drawCircle(color = surfaceColor, radius = 2.dp.toPx(), center = Offset(x, y))
                }
            }
        }
    }
}

@Composable
private fun ForecastLegend(chartRoutes: List<Route>) {
    Row(
        modifier = Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.spacedBy(12.dp)
    ) {
        chartRoutes.forEachIndexed { index, route ->
            Row(
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(4.dp),
                modifier = Modifier.weight(1f)
            ) {
                Canvas(modifier = Modifier.size(8.dp)) {
                    drawCircle(color = CHART_COLORS[index])
                }
                Text(
                    text = route.title,
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis
                )
            }
        }
    }
}

internal fun orderedDaysFromToday(): List<String> {
    val allDays = listOf("MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN")
    val todayIndex = when (LocalDate.now().dayOfWeek) {
        DayOfWeek.MONDAY -> 0
        DayOfWeek.TUESDAY -> 1
        DayOfWeek.WEDNESDAY -> 2
        DayOfWeek.THURSDAY -> 3
        DayOfWeek.FRIDAY -> 4
        DayOfWeek.SATURDAY -> 5
        DayOfWeek.SUNDAY -> 6
        else -> 0
    }
    return (0..6).map { allDays[(todayIndex + it) % 7] }
}
