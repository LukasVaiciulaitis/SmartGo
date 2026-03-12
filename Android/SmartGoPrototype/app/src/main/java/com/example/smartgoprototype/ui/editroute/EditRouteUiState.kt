package com.example.smartgoprototype.ui.editroute

import com.example.smartgoprototype.domain.model.TravelMode
import java.time.DayOfWeek
import java.time.LocalTime

data class EditRouteUiState(
    val routeId: String = "",
    val title: String = "",
    val originLabel: String = "",
    val destinationLabel: String = "",
    val travelMode: TravelMode = TravelMode.DRIVE,
    val arriveBy: LocalTime = LocalTime.of(9, 0),
    val activeDays: Set<DayOfWeek> = emptySet(),
    val isLoading: Boolean = true,
    val isSaving: Boolean = false,
    val errorMessage: String? = null
) {
    val canSave: Boolean
        get() = !isLoading &&
                routeId.isNotBlank() &&
                title.isNotBlank() &&
                activeDays.isNotEmpty() &&
                !isSaving
}
