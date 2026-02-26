package com.example.smartgoprototype.ui.addroute

import com.example.smartgoprototype.domain.model.PlaceLocation
import java.time.DayOfWeek
import java.time.LocalTime

data class AddRouteUiState(
    val title: String = "",
    val origin: PlaceLocation? = null,
    val destination: PlaceLocation? = null,
    val arriveBy: LocalTime = LocalTime.of(9, 0),
    val activeDays: Set<DayOfWeek> = setOf(
        DayOfWeek.MONDAY,
        DayOfWeek.TUESDAY,
        DayOfWeek.WEDNESDAY,
        DayOfWeek.THURSDAY,
        DayOfWeek.FRIDAY
    ),
    val isSaving: Boolean = false,
    val errorMessage: String? = null
) {
    val canSave: Boolean
        get() = title.isNotBlank() && origin != null && destination != null && activeDays.isNotEmpty() && !isSaving
}